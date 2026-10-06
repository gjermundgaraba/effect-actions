import { describe, expect, it } from "@effect/vitest";
import {
  Cause,
  Context,
  Effect,
  Latch,
  Layer,
  Option,
  Predicate,
  Redacted,
  Schema,
  SchemaIssue,
  Stream,
} from "effect";
import { Command } from "effect/cli";
import { McpServer } from "effect/ai";
import * as Action from "../src/Action.js";
import * as ActionCli from "../src/ActionCli.js";
import * as ActionHttp from "../src/ActionHttp.js";
import * as ActionMcp from "../src/ActionMcp.js";
import * as ActionToolkit from "../src/ActionToolkit.js";
import * as Authentication from "../src/Authentication.js";
import * as Testing from "../src/Testing.js";
import { causeOf, exec, printed } from "./cli-services.js";
import { as, mcpRequest, post, rawToolCall, send, withBearer } from "./requests.js";
import { serve } from "./serve.js";

class Scopes extends Context.Service<Scopes, ReadonlyArray<string>>()("access-test/Scopes") {}

class Caller extends Context.Service<Caller, string>()("access-test/Caller") {}

/** How a remote caller proves its scopes: its token lists them, and `none` lists none. */
const ScopesLogin = Authentication.make("access-test.ScopesLogin", Scopes);

const grants = Authentication.layer(ScopesLogin, (token: Redacted.Redacted<string>) =>
  Effect.succeed(Redacted.value(token) === "none" ? [] : Redacted.value(token).split(",")),
);

/** A caller of any token: what OAuth step-up answers under. */
const Anyone = Authentication.make("access-test.Anyone", Caller);

const anyone = Authentication.layer(Anyone, () => Effect.succeed("anyone"));

const Read = Action.make("read", {
  description: "Read the resource",
  access: "read",
  auth: Scopes,
  success: Schema.String,
});

const Write = Action.make("write", {
  description: "Change the resource",
  access: "write",
  auth: Scopes,
  input: { value: Schema.String },
  success: Schema.String,
});

// The authorizer answers instead of a handler with a built-in refusal, which every endpoint
// declares, so the binding needs no errors of its own.
const Http = ActionHttp.make([Read, Write], { authentication: ScopesLogin });

/**
 * One rule for a whole implementation, read from the contract rather than from a name list. No
 * scopes at all is unauthenticated; a read-only grant is forbidden to write.
 */
const authorize =
  (seen: Array<string>) =>
  (action: Action.Any): Effect.Effect<void, Action.Refusal, Scopes> =>
    Effect.gen(function* () {
      seen.push(action.name);
      const granted = yield* Scopes;

      if (granted.length === 0) return yield* new Action.Unauthenticated({ message: "Sign in." });

      if (action.access === "read") return;

      if (!granted.includes("write")) {
        return yield* new Action.Forbidden({ message: "Requires write." });
      }
    });

/** A fresh implementation per test, with the authorizer and handler invocations it recorded. */
const make = () => {
  const authorized: Array<string> = [];
  const handlers: Array<string> = [];
  const record = (name: string) => Effect.sync(() => (handlers.push(name), `${name} ok`));

  return {
    authorized,
    handlers,
    app: Action.implement(
      [Read, Write],
      {
        read: () => record("read"),
        write: () => record("write"),
      },
      { authorize: authorize(authorized) },
    ),
  };
};

const readOnly = Layer.succeed(Scopes, ["read"]);

type App = ReturnType<typeof make>["app"];

/** Serve the actions over HTTP, each request granted the scopes its token lists. */
const serveHttp = (app: App) => serve(ActionHttp.layer(Http, app).pipe(Layer.provide(grants)));

/** `request`, granted only the read scope. */
const reading = (request: Request) => withBearer(request, "read");

describe("action access", () => {
  it("refuses a value the contract does not define, so plain JavaScript cannot skip a rule", () => {
    expect(() =>
      Action.make("unclassified", {
        description: "Classified by nobody",
        // @ts-expect-error The check exists for callers the compiler never sees.
        access: "admin",
        auth: "public",
        success: Schema.String,
      }),
    ).toThrow("Invalid access: admin");
  });

  it("refuses a contract stating no one who may call it", () => {
    for (const auth of [undefined, "anyone"]) {
      expect(() =>
        // @ts-expect-error The check exists for callers the compiler never sees.
        Action.make("unstated", { description: "", access: "read", auth }),
      ).toThrow("Missing auth: declare public or an identity service key");
    }
  });

  it("refuses a Context.Reference as an identity, whose default would stand in for every caller", () => {
    const Anyone = Context.Reference<string>("access/Anyone", { defaultValue: () => "anyone" });

    expect(() =>
      // @ts-expect-error The check exists for callers the compiler never sees.
      Action.make("byDefault", { description: "", access: "read", auth: Anyone }),
    ).toThrow("Invalid auth: an identity is a Context.Service, not a Context.Reference");
  });
});

describe("the authorizer", () => {
  it("runs once before each handler over HTTP and answers as a built-in refusal", async () => {
    const { app, authorized, handlers } = make();
    const web = serveHttp(app);

    const allowed = await web.handler(reading(post("/api/read")));
    expect(allowed.status).toBe(200);
    expect(await allowed.json()).toBe("read ok");

    const refused = await web.handler(reading(post("/api/write", { value: "x" })));
    expect(refused.status).toBe(403);
    // The body is the refusal, encoded by its own schema like a handler's error.
    expect(await refused.json()).toEqual(
      Schema.encodeSync(Action.Forbidden)(new Action.Forbidden({ message: "Requires write." })),
    );

    expect(authorized).toEqual(["read", "write"]);
    expect(handlers).toEqual(["read"]);
  });

  it("decodes HTTP input before running either the authorizer or handler, after authenticating", async () => {
    const { app, authorized, handlers } = make();
    const web = serveHttp(app);

    // Without a token, the authentication refuses before decoding.
    expect((await web.handler(post("/api/write", { value: 42 }))).status).toBe(401);

    const invalid = await web.handler(reading(post("/api/write", { value: 42 })));
    expect(invalid.status).toBe(400);
    expect(authorized).toEqual([]);
    expect(handlers).toEqual([]);

    const refused = await web.handler(reading(post("/api/write", { value: "x" })));
    expect(refused.status).toBe(403);
    expect(authorized).toEqual(["write"]);
    expect(handlers).toEqual([]);
  });

  it("runs over MCP, where a refusal naming no scope is the tool's declared failure", async () => {
    const { app, authorized, handlers } = make();

    const mcp = serve(
      ActionMcp.layerHttp(app, { name: "test", version: "0", authentication: ScopesLogin }).pipe(
        Layer.provide(grants),
      ),
    );

    expect(await (await mcp.handler(reading(rawToolCall("read")))).json()).toMatchObject({
      result: { isError: false, structuredContent: "read ok" },
    });
    expect(
      await (await mcp.handler(reading(rawToolCall("write", { value: "x" })))).json(),
    ).toMatchObject({
      result: {
        isError: true,
        content: [{ type: "text", text: '{"_tag":"Forbidden","message":"Requires write."}' }],
      },
    });

    expect(authorized).toEqual(["read", "write"]);
    expect(handlers).toEqual(["read"]);
  });

  it("answers a refusal a client steps up on with its HTTP status under authentication, an authorizer's or a handler's", async () => {
    const needsWrite = new Action.Forbidden({ message: "Needs write.", scopes: ["write"] });

    const Gated = Action.make("gated", {
      description: "Refused by its authorizer",
      access: "write",
      auth: Caller,
    });

    const Handled = Action.make("handled", {
      description: "Refused by its handler",
      access: "write",
      auth: Caller,
    });

    const Plain = Action.make("plain", {
      description: "Refused by its authorizer, naming no scope",
      access: "write",
      auth: Caller,
    });

    const app = Action.implement(
      [Gated, Handled, Plain],
      {
        gated: () => Effect.void,
        handled: () => Effect.fail(needsWrite),
        plain: () => Effect.void,
      },
      {
        authorize: (action) =>
          action === Handled
            ? Effect.void
            : Effect.fail(action === Gated ? needsWrite : new Action.Forbidden()),
      },
    );

    const web = serve(
      Layer.mergeAll(
        ActionHttp.layer(ActionHttp.make([Gated, Handled, Plain], { authentication: Anyone }), app),
        ActionMcp.layerHttp(app, { name: "test", version: "0", authentication: Anyone }),
      ).pipe(Layer.provide(anyone)),
    );

    const calls = [
      post("/api/gated"),
      post("/api/handled"),
      rawToolCall("gated"),
      rawToolCall("handled"),
    ];

    for (const call of calls) {
      const refused = await web.handler(withBearer(call, "x"));

      expect(refused.status).toBe(403);
      expect(refused.headers.get("www-authenticate")).toBe(
        'Bearer error="insufficient_scope", scope="write", error_description="Needs write."',
      );
      expect(await refused.json()).toEqual(Schema.encodeSync(Action.Forbidden)(needsWrite));
    }

    // A refusal naming no scope has no challenge: re-authorizing would not help.
    const plain = await web.handler(withBearer(post("/api/plain"), "x"));
    expect(plain.status).toBe(403);
    expect(plain.headers.get("www-authenticate")).toBeNull();

    // Unauthenticated is a 401 over MCP too: a client authenticates on it.
    const { app: guarded } = make();

    const unauthenticated = await serve(
      ActionMcp.layerHttp(guarded, {
        name: "test",
        version: "0",
        authentication: ScopesLogin,
      }).pipe(Layer.provide(grants)),
    ).handler(withBearer(rawToolCall("read"), "none"));

    expect(unauthenticated.status).toBe(401);
    expect(await unauthenticated.json()).toEqual(
      Schema.encodeSync(Action.Unauthenticated)(
        new Action.Unauthenticated({ message: "Sign in." }),
      ),
    );

    // A public action has no authentication, so no OAuth client to step up: HTTP answers its
    // handler's refusal as it is, unchallenged, and over MCP the model reads a result.
    const Open = Action.make("open", {
      description: "Refused by its handler, with no authentication",
      access: "write",
      auth: "public",
    });

    const signIn = new Action.Unauthenticated({ message: "Sign in." });

    const open = await serve(
      ActionHttp.layer(
        ActionHttp.make([Open]),
        Action.implement(Open, () => Effect.fail(needsWrite)),
      ),
    ).handler(post("/api/open"));

    expect(open.status).toBe(403);
    expect(open.headers.get("www-authenticate")).toBeNull();

    const result = await serve(
      ActionMcp.layerHttp(
        Action.implement(Open, () => Effect.fail(signIn)),
        { name: "test", version: "0" },
      ),
    ).handler(rawToolCall("open"));

    expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({
      result: {
        isError: true,
        content: [
          {
            type: "text",
            text: JSON.stringify(Schema.encodeSync(Action.Unauthenticated)(signIn)),
          },
        ],
      },
    });
  });

  it("keeps each request's step-up refusal its own under concurrent calls", async () => {
    const Allowed = Action.make("allowed", {
      description: "Allowed",
      access: "read",
      auth: Caller,
    });

    const Refused = Action.make("refused", {
      description: "Refused",
      access: "write",
      auth: Caller,
    });

    const app = Action.implement(
      [Allowed, Refused],
      { allowed: () => Effect.sleep("1 millis"), refused: () => Effect.void },
      {
        authorize: (action) =>
          action === Refused
            ? Effect.fail(new Action.Forbidden({ scopes: ["write"] }))
            : Effect.void,
      },
    );

    const web = serve(
      Layer.mergeAll(
        ActionHttp.layer(ActionHttp.make([Allowed, Refused], { authentication: Anyone }), app),
        ActionMcp.layerHttp(app, { name: "test", version: "0", authentication: Anyone }),
      ).pipe(Layer.provide(anyone)),
    );

    const calls = Array.from({ length: 25 }).flatMap(
      (): ReadonlyArray<readonly [Request, number]> => [
        [post("/api/allowed"), 200],
        [post("/api/refused"), 403],
        [rawToolCall("allowed"), 200],
        [rawToolCall("refused"), 403],
      ],
    );

    const statuses = await Promise.all(
      calls.map(async ([call]) => (await web.handler(withBearer(call, "x"))).status),
    );

    expect(statuses).toEqual(calls.map(([, status]) => status));
  });

  it("answers a handler's step-up refusal as a tool result once its call has streamed", async () => {
    const Reporting = Action.make("reporting", {
      description: "Reports progress, then refuses",
      access: "write",
      auth: Caller,
    });

    // Opened once the test has the response: the refusal comes only after it has started.
    const streamed = Latch.makeUnsafe();

    const app = Action.implement(
      Reporting,
      () =>
        Effect.gen(function* () {
          // Its endpoint's registry, which no host provides.
          const server = yield* McpServer.McpServer;

          yield* server.notifications["notifications/progress"]({
            progressToken: "call",
            progress: 1,
          });

          yield* streamed.await;

          return yield* new Action.Forbidden({ scopes: ["write"] });
        }),
      { authorize: Action.allowAll },
    );

    const mcp = serve(
      ActionMcp.layerHttp(app, { name: "test", version: "0", authentication: Anyone }).pipe(
        Layer.provide(anyone),
      ),
    );

    const reply = await mcp.handler(
      mcpRequest({
        method: "tools/call",
        params: { name: "reporting", arguments: {}, _meta: { progressToken: "call" } },
        headers: { authorization: "Bearer x" },
      }),
    );

    // The progress went out with a 200: the refusal can only follow it as the tool's result.
    expect(reply.status).toBe(200);
    expect(reply.headers.get("www-authenticate")).toBeNull();
    streamed.openUnsafe();

    const text = await reply.text();
    expect(text).toContain('"method":"notifications/progress"');
    expect(text).toContain('"isError":true');
    expect(text).toContain(String.raw`\"_tag\":\"Forbidden\"`);
  });

  it.effect("runs over the native Toolkit", () =>
    Effect.gen(function* () {
      const { app, authorized, handlers } = make();

      const binding = ActionToolkit.make(app);

      const call = (name: "read" | "write") =>
        Effect.gen(function* () {
          const tools = yield* binding.toolkit;

          return yield* Stream.runCollect(
            yield* tools.handle(name, name === "write" ? { value: "x" } : {}),
          );
        }).pipe(Effect.provide(binding.layer), Effect.provide(readOnly));

      expect(yield* call("read")).toMatchObject([{ isFailure: false, result: "read ok" }]);

      const refused = yield* call("write");
      const refusal = new Action.Forbidden({ message: "Requires write." });

      // The refusal itself, encoded like a declared error.
      expect(refused).toMatchObject([
        {
          isFailure: true,
          result: refusal,
          encodedResult: Schema.encodeSync(Action.Forbidden)(refusal),
        },
      ]);
      expect(refused[0]?.result).toBeInstanceOf(Action.Forbidden);

      expect(authorized).toEqual(["read", "write"]);
      expect(handlers).toEqual(["read"]);
    }),
  );

  it.effect("runs over the CLI, so a local caller supplies its services too", () =>
    Effect.gen(function* () {
      const { app, authorized, handlers } = make();

      const run = <Name extends string, Input, Services, E>(
        command: Command.Command<Name, Input, Services, E, Scopes>,
        argv: ReadonlyArray<string>,
      ) => printed(exec(command, argv)).pipe(Effect.provide(readOnly));

      const [read, output] = yield* run(ActionCli.command(app, Read), []);
      expect(read._tag).toBe("Success");
      expect(output).toEqual(['"read ok"']);

      const [refused] = yield* run(ActionCli.command(app, Write), ["--value", "x"]);

      expect(causeOf(refused)).toBeInstanceOf(Action.Forbidden);

      expect(authorized).toEqual(["read", "write"]);
      expect(handlers).toEqual(["read"]);
    }),
  );

  it("is bound per implementation, so implementations without it skip it", async () => {
    const authorized: Array<string> = [];
    const handlers: Array<string> = [];
    const record = (name: string) => Effect.sync(() => (handlers.push(name), `${name} ok`));
    const read = Action.implement(Read, () => record("read"), { authorize: Action.allowAll });

    const write = Action.implement(Write, () => record("write"), {
      authorize: authorize(authorized),
    });

    // One layer: only the write implementation has the authorizer.
    const web = serve(ActionHttp.layer(Http, [read, write]).pipe(Layer.provide(grants)));

    expect((await web.handler(reading(post("/api/read")))).status).toBe(200);
    expect((await web.handler(reading(post("/api/write", { value: "x" })))).status).toBe(403);
    expect(authorized).toEqual(["write"]);
    expect(handlers).toEqual(["read"]);
  });

  it("never runs for a public action, even beside protected ones in one implementation", async () => {
    const authorized: Array<string> = [];

    const Status = Action.make("status", {
      description: "Answer anyone",
      access: "read",
      auth: "public",
      success: Schema.String,
    });

    const app = Action.implement(
      [Status, Read],
      { status: () => Effect.succeed("up"), read: () => Effect.succeed("read ok") },
      { authorize: authorize(authorized) },
    );

    const web = serve(
      ActionHttp.layer(ActionHttp.make([Status, Read], { authentication: ScopesLogin }), app).pipe(
        Layer.provide(grants),
      ),
    );

    expect(await (await web.handler(post("/api/status"))).json()).toBe("up");
    expect(authorized).toEqual([]);
    expect(await (await web.handler(reading(post("/api/read")))).json()).toBe("read ok");
    expect(authorized).toEqual(["read"]);
  });

  it.effect.each([
    [new Action.Unauthenticated(), 401, 'Bearer error="invalid_token"'],
    [new Action.Forbidden({ message: "Requires write." }), 403, undefined],
  ] as const)(
    "answers its %s over HTTP with its status, and to the client",
    ([refusal, status, challenge]) =>
      Effect.gen(function* () {
        const response = yield* send(reading(post("/api/write", { value: "x" })));
        expect(response.status).toBe(status);
        expect(yield* response.json).toEqual(
          Schema.encodeSync(Schema.Union([Action.Unauthenticated, Action.Forbidden]))(refusal),
        );
        // The authentication challenges a 401, whose request presented a token it took; a
        // refusal naming no scope has nothing to step up to.
        expect(response.headers["www-authenticate"]).toBe(challenge);

        const client = yield* ActionHttp.client(Http, as("read"));

        expect(yield* Effect.flip(client.write({ value: "x" }))).toEqual(refusal);
      }).pipe(
        Effect.provide(
          Testing.layer(
            ActionHttp.layer(
              Http,
              Action.implement(Write, ({ value }) => Effect.succeed(value), {
                authorize: () => Effect.fail(refusal),
              }),
            ).pipe(Layer.provide(grants)),
          ),
        ),
      ),
  );
});

describe("declared checks", () => {
  class RateLimited extends Schema.TaggedError<RateLimited>()(
    "RateLimited",
    { retryAfter: Schema.Finite },
    { httpApiStatus: 429 },
  ) {}

  /** A rate limit: its error joins the errors of every action listing it. */
  class Limited extends Action.Check<Limited>()("access-test/Limited", { error: RateLimited }) {}

  const Ping = Action.make("ping", {
    description: "Ping",
    access: "read",
    auth: Caller,
    success: Schema.String,
    checks: [Limited],
  });

  const Poke = Action.make("poke", {
    description: "Poke",
    access: "write",
    auth: Caller,
    input: { value: Schema.String },
    success: Schema.String,
    checks: [Limited],
  });

  const limited = new RateLimited({ retryAfter: 30 });

  const app = Action.implement(
    [Ping, Poke],
    { ping: () => Effect.succeed("pong"), poke: ({ value }) => Effect.succeed(value) },
    { authorize: Action.allowAll },
  );

  const Http = ActionHttp.make([Ping, Poke], { authentication: Anyone });

  it.effect("fails with the error it declares, answered as the action's own everywhere", () =>
    Effect.gen(function* () {
      // Writes are over their quota; reads are not.
      const limits = Layer.effect(
        Limited,
        Effect.succeed((action: Action.Any) =>
          action.access === "write" ? Effect.fail(limited) : Effect.void,
        ),
      );

      // Under authentication, which answers a step-up refusal itself: a limit is no refusal.
      const served = Testing.layer(
        Layer.mergeAll(
          ActionHttp.layer(Http, app),
          ActionMcp.layerHttp(app, { name: "test", version: "0", authentication: Anyone }),
        ).pipe(Layer.provide([anyone, limits])),
      );

      yield* Effect.gen(function* () {
        expect((yield* send(withBearer(post("/api/ping"), "x"))).status).toBe(200);

        // HTTP answers with the error's own status and JSON, and no challenge.
        const answered = yield* send(withBearer(post("/api/poke", { value: "x" }), "x"));

        expect(answered.status).toBe(429);
        expect(answered.headers).not.toHaveProperty("www-authenticate");
        expect(yield* answered.json).toEqual(Schema.encodeSync(RateLimited)(limited));

        // MCP answers with a tool result the model reads, not an HTTP status.
        const result = yield* send(withBearer(rawToolCall("poke", { value: "x" }), "x"));

        expect(result.status).toBe(200);
        expect(yield* result.json).toMatchObject({
          result: {
            isError: true,
            content: [{ type: "text", text: '{"_tag":"RateLimited","retryAfter":30}' }],
          },
        });

        // A remote command decodes it, as `ActionHttp.client` does: the cause of its `UserError`.
        const remote = yield* Effect.exit(
          exec(ActionCli.command(Http, Poke, { client: as("x") }), ["--value", "x"]),
        );

        expect(causeOf(remote)).toEqual(limited);
        expect(causeOf(remote)).toBeInstanceOf(RateLimited);
      }).pipe(Effect.provide(served));

      yield* Effect.gen(function* () {
        // `Action.client` fails with it, as an HTTP client decodes it.
        const called = yield* Effect.flatMap(Action.client(app), (client) =>
          Effect.flip(client.poke({ value: "x" })),
        );

        expect(called).toEqual(limited);
        expect(called).toBeInstanceOf(RateLimited);

        // The Toolkit returns it as the tool's failure.
        const tools = ActionToolkit.make(app);

        const returned = yield* Effect.gen(function* () {
          const toolkit = yield* tools.toolkit;

          return yield* Stream.runCollect(yield* toolkit.handle("poke", { value: "x" }));
        }).pipe(Effect.provide(tools.layer));

        expect(returned).toMatchObject([
          {
            isFailure: true,
            result: limited,
            encodedResult: Schema.encodeSync(RateLimited)(limited),
          },
        ]);
        expect(returned[0]?.result).toBeInstanceOf(RateLimited);

        // A local command fails with Effect CLI's `UserError`, whose cause it is.
        const local = yield* Effect.exit(exec(ActionCli.command(app, Poke), ["--value", "x"]));

        expect(causeOf(local)).toBeInstanceOf(RateLimited);
      }).pipe(Effect.provideService(Caller, "local"), Effect.provide(limits));
    }),
  );

  it.effect("is built once per layer graph, so every surface of it shares one limit", () =>
    Effect.gen(function* () {
      let builds = 0;

      // One call per caller, counted across HTTP and MCP.
      const once = Layer.effect(
        Limited,
        Effect.sync(() => {
          builds++;
          const seen = new Set<string>();

          return () =>
            Effect.suspend(() =>
              seen.has("anyone")
                ? Effect.fail(limited)
                : Effect.sync(() => void seen.add("anyone")),
            );
        }),
      );

      yield* Effect.gen(function* () {
        const http = yield* ActionHttp.client(Http, as("x"));
        const mcp = yield* Testing.mcpClient([Poke], as("x"));

        expect(yield* http.poke({ value: "first" })).toBe("first");
        expect(yield* Effect.flip(mcp.poke({ value: "second" }))).toEqual(limited);
        expect(yield* Effect.flip(http.poke({ value: "third" }))).toEqual(limited);
      }).pipe(
        Effect.provide(
          Testing.layer(
            Layer.mergeAll(
              ActionHttp.layer(Http, app),
              ActionMcp.layerHttp(app, { name: "test", version: "0", authentication: Anyone }),
            ).pipe(Layer.provide([anyone, once])),
          ),
        ),
      );

      expect(builds).toBe(1);
    }),
  );

  it.effect("runs once per call, though listed twice", () =>
    Effect.gen(function* () {
      class Busy extends Schema.TaggedError<Busy>()("Busy", {}) {}

      class Counted extends Action.Check<Counted>()("access-test/Counted", { error: Busy }) {}

      // A spread shared list repeats it.
      const shared = [Counted];

      const Status = Action.make("status", {
        description: "A public action listing one check twice",
        access: "read",
        auth: "public",
        checks: [...shared, Counted],
      });

      expect(Status.checks).toEqual([Counted]);

      let runs = 0;

      const client = yield* Action.client(Action.implement(Status, () => Effect.void)).pipe(
        Effect.provide(Layer.succeed(Counted, () => Effect.sync(() => void runs++))),
      );

      yield* client.status();
      expect(runs).toBe(1);
    }),
  );

  it.effect("runs for a public action too, before its handler", () =>
    Effect.gen(function* () {
      class Busy extends Schema.TaggedError<Busy>()("Busy", {}, { httpApiStatus: 429 }) {}

      class Capacity extends Action.Check<Capacity>()("access-test/Capacity", { error: Busy }) {}

      const Status = Action.make("status", {
        description: "A public action with an operational limit",
        access: "read",
        auth: "public",
        checks: [Capacity],
      });

      let handled = false;

      const status = Action.implement(Status, () =>
        Effect.sync(() => {
          handled = true;
        }),
      );

      const full = Layer.effect(
        Capacity,
        Effect.succeed(() => Effect.fail(new Busy())),
      );

      const client = yield* Action.client(status).pipe(Effect.provide(full));
      expect(yield* Effect.flip(client.status())).toBeInstanceOf(Busy);

      // Over HTTP too, where no authentication covers it.
      const response = yield* send(post("/api/status")).pipe(
        Effect.provide(
          Testing.layer(
            ActionHttp.layer(ActionHttp.make([Status]), status).pipe(Layer.provide(full)),
          ),
        ),
      );

      expect(response.status).toBe(429);
      expect(handled).toBe(false);
    }),
  );

  it.effect("reads every request service it declares and releases what it acquires per call", () =>
    Effect.gen(function* () {
      class Busy extends Schema.TaggedError<Busy>()("Busy", {}) {}

      class Region extends Context.Service<Region, string>()("access-test/Region") {}

      class Tenant extends Context.Service<Tenant, string>()("access-test/Tenant") {}

      class Quota extends Action.Check<Quota>()("access-test/Quota", {
        error: Busy,
        requires: [Region, Tenant],
      }) {}

      const Status = Action.make("status", {
        description: "A public action with a per-tenant limit",
        access: "read",
        auth: "public",
        checks: [Quota],
      });

      const status = Action.implement(Status, () => Effect.void);
      const log: Array<string> = [];

      // A slot held for the call: released when the call ends, whether the check refuses it.
      const quota = Layer.succeed(Quota, () =>
        Effect.gen(function* () {
          const region = yield* Region;
          const tenant = yield* Tenant;

          yield* Effect.acquireRelease(
            Effect.sync(() => log.push(`acquire ${region}/${tenant}`)),
            () => Effect.sync(() => log.push(`release ${region}/${tenant}`)),
          );

          if (tenant === "full") {
            return yield* Effect.fail(new Busy());
          }
        }),
      );

      const client = yield* Action.client(status).pipe(Effect.provide(quota));

      const call = (tenant: string) =>
        client
          .status()
          .pipe(Effect.provideService(Region, "eu"), Effect.provideService(Tenant, tenant));

      yield* call("open");
      expect(yield* Effect.flip(call("full"))).toBeInstanceOf(Busy);
      expect(log).toEqual([
        "acquire eu/open",
        "release eu/open",
        "acquire eu/full",
        "release eu/full",
      ]);
    }),
  );

  it.effect("passes the error its schema checks asynchronously, as the handler's", () =>
    Effect.gen(function* () {
      // A code checked only once a promise settles, as a lookup would.
      const Code = Schema.declareConstructor<string>()(
        [],
        () => (input, ast) =>
          Effect.promise(() => Promise.resolve()).pipe(
            Effect.flatMap(() =>
              Predicate.isString(input)
                ? Effect.succeed(input)
                : Effect.fail(new SchemaIssue.InvalidType(ast, Option.some(input))),
            ),
          ),
        { toCodecJson: () => undefined },
      );

      const Quota = Schema.TaggedStruct("Quota", { code: Code });
      const quota = yield* Quota.makeEffect({ code: "quota" });

      class Gate extends Action.Check<Gate>()("access-test/Gate", { error: Quota }) {}

      const Status = Action.make("status", {
        description: "Status",
        access: "read",
        auth: "public",
        checks: [Gate],
      });

      const open = Layer.effect(
        Gate,
        Effect.succeed(() => Effect.void),
      );

      const closed = Layer.effect(
        Gate,
        Effect.succeed(() => Effect.fail(quota)),
      );

      const fromHandler = Action.client(Action.implement(Status, () => Effect.fail(quota))).pipe(
        Effect.provide(open),
      );

      const fromCheck = Action.client(Action.implement(Status, () => Effect.void)).pipe(
        Effect.provide(closed),
      );

      for (const made of [fromHandler, fromCheck]) {
        const client = yield* made;

        expect(yield* Effect.flip(client.status())).toEqual(quota);
      }
    }),
  );

  it.effect("keeps its failure's whole cause: its trace and a defect beside it", () =>
    Effect.gen(function* () {
      const cleanup = new Error("cleanup failed");

      // Refused in a span of its own, with a cleanup that dies.
      const quota = Layer.effect(
        Limited,
        Effect.succeed(() =>
          Effect.fail(limited).pipe(Effect.ensuring(Effect.die(cleanup)), Effect.withSpan("quota")),
        ),
      );

      const client = yield* Action.client(app, { actions: [Ping] }).pipe(Effect.provide(quota));

      const cause = yield* Effect.flip(
        Effect.sandbox(client.ping().pipe(Effect.provideService(Caller, "local"))),
      );

      expect(cause.reasons.filter(Cause.isFailReason).map(({ error }) => error)).toEqual([limited]);
      expect(cause.reasons.filter(Cause.isDieReason).map(({ defect }) => defect)).toEqual([
        cleanup,
      ]);
      expect(Cause.pretty(cause)).toMatch(/^\s+at quota \(.*access\.test\.ts/m);
    }),
  );
});

describe("a trusted local caller", () => {
  /** A caller a token can name: what every remote verifier returns. */
  interface RemoteActor {
    readonly id: string;
    readonly role: "reader" | "writer";
  }

  /** The operator of a trusted local program, which no token names: only a host supplies it. */
  interface TrustedActor {
    readonly id: string;
    readonly role: "trusted-admin";
  }

  class Actor extends Context.Service<Actor, RemoteActor | TrustedActor>()("access-test/Actor") {}

  class RateLimited extends Schema.TaggedError<RateLimited>()("RateLimited", {
    retryAfter: Schema.Finite,
  }) {}

  class Limited extends Action.Check<Limited>()("access-test/TrustedLimited", {
    error: RateLimited,
    requires: Actor,
  }) {}

  const Rename = Action.make("renameUser", {
    description: "Rename a user, subject to the rate limit",
    access: "write",
    auth: Actor,
    checks: [Limited],
    input: { name: Schema.String },
    success: { name: Schema.String, caller: Schema.String },
  });

  /** One rule, which a trusted operator passes: no policy replaces it for the CLI. */
  const authorize = (action: Action.Any) =>
    Effect.gen(function* () {
      const actor = yield* Actor;

      if (actor.role === "trusted-admin") return;

      if (action.access === "write" && actor.role !== "writer") {
        return yield* new Action.Forbidden({ scopes: ["users:write"] });
      }
    });

  /** The admin CLI, the limit allowing `maximum` calls per caller, recording each rename. */
  const cli = (maximum: number) => {
    const calls: Array<string> = [];

    const app = Action.implement(
      Rename,
      ({ name }) =>
        Effect.map(Actor, ({ id }) => {
          calls.push(id);

          return { name, caller: id };
        }),
      { authorize },
    );

    const counts = new Map<string, number>();

    const limit = Layer.effect(
      Limited,
      Effect.succeed(() =>
        Effect.flatMap(Actor, ({ id }) =>
          Effect.suspend(() => {
            const count = counts.get(id) ?? 0;

            if (count >= maximum) return Effect.fail(new RateLimited({ retryAfter: 30 }));
            counts.set(id, count + 1);

            return Effect.void;
          }),
        ),
      ),
    );

    const admin: TrustedActor = { id: "maintenance", role: "trusted-admin" };

    const command = ActionCli.make(app, { name: "admin", actions: [Rename] }).pipe(
      Command.provide(limit),
      Command.provideSync(Actor, admin),
    );

    return { calls, command };
  };

  it.effect("passes the same authorizer and handlers, with no policy override", () =>
    Effect.gen(function* () {
      const { calls, command } = cli(2);

      const [exit, stdout] = yield* printed(exec(command, ["rename-user", "--name", "Admin"]));

      expect(exit._tag).toBe("Success");
      expect(stdout.join("\n")).toContain('"caller": "maintenance"');
      expect(calls).toEqual(["maintenance"]);
    }),
  );

  it.effect("still runs the checks, which refuse it over its limit", () =>
    Effect.gen(function* () {
      const { calls, command } = cli(0);

      const [exit] = yield* printed(exec(command, ["rename-user", "--name", "Admin"]));

      expect(causeOf(exit)).toBeInstanceOf(RateLimited);
      expect(calls).toEqual([]);
    }),
  );
});
