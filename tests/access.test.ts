import { describe, expect, it } from "@effect/vitest";
import { Context, Effect, Latch, Layer, Redacted, Schema, Stream } from "effect";
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
const AnyCaller = Authentication.make("access-test.AnyCaller", Caller);

const anyone = Authentication.layer(AnyCaller, () => Effect.succeed("anyone"));

const Read = Action.make("read", {
  description: "Read the resource",
  readOnly: true,
  caller: Scopes,
  success: Schema.String,
});

const Write = Action.make("write", {
  description: "Change the resource",
  readOnly: false,
  caller: Scopes,
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

      if (action.readOnly) return;

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

describe("action classification", () => {
  it("refuses a readOnly that is not a boolean, so plain JavaScript cannot skip a rule", () => {
    for (const readOnly of [undefined, "read"]) {
      expect(() =>
        Action.make("unclassified", {
          description: "Classified by nobody",
          // @ts-expect-error The check exists for callers the compiler never sees.
          readOnly,
          caller: Action.Anyone,
          success: Schema.String,
        }),
      ).toThrow(`Invalid readOnly: ${readOnly}`);
    }
  });

  it("refuses a contract stating no one who may call it", () => {
    for (const caller of [undefined, "public"]) {
      expect(() =>
        // @ts-expect-error The check exists for callers the compiler never sees.
        Action.make("unstated", { description: "", readOnly: true, caller }),
      ).toThrow("Missing caller: declare Action.Anyone or an identity service key");
    }
  });

  it("refuses a Context.Reference as an identity, whose default would stand in for every caller", () => {
    const Default = Context.Reference<string>("access/Default", { defaultValue: () => "anyone" });

    expect(() =>
      // @ts-expect-error The check exists for callers the compiler never sees.
      Action.make("byDefault", { description: "", readOnly: true, caller: Default }),
    ).toThrow("Invalid caller: an identity is a Context.Service, not a Context.Reference");
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
      readOnly: false,
      caller: Caller,
    });

    const Handled = Action.make("handled", {
      description: "Refused by its handler",
      readOnly: false,
      caller: Caller,
    });

    const Plain = Action.make("plain", {
      description: "Refused by its authorizer, naming no scope",
      readOnly: false,
      caller: Caller,
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
        ActionHttp.layer(
          ActionHttp.make([Gated, Handled, Plain], { authentication: AnyCaller }),
          app,
        ),
        ActionMcp.layerHttp(app, { name: "test", version: "0", authentication: AnyCaller }),
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
      readOnly: false,
      caller: Action.Anyone,
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
      readOnly: true,
      caller: Caller,
    });

    const Refused = Action.make("refused", {
      description: "Refused",
      readOnly: false,
      caller: Caller,
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
        ActionHttp.layer(ActionHttp.make([Allowed, Refused], { authentication: AnyCaller }), app),
        ActionMcp.layerHttp(app, { name: "test", version: "0", authentication: AnyCaller }),
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
      readOnly: false,
      caller: Caller,
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
      ActionMcp.layerHttp(app, { name: "test", version: "0", authentication: AnyCaller }).pipe(
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
      readOnly: true,
      caller: Action.Anyone,
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

  const Rename = Action.make("renameUser", {
    description: "Rename a user",
    readOnly: false,
    caller: Actor,
    input: { name: Schema.String },
    success: { name: Schema.String, caller: Schema.String },
  });

  /** One rule, which a trusted operator passes: no policy replaces it for the CLI. */
  const authorize = (action: Action.Any) =>
    Effect.gen(function* () {
      const actor = yield* Actor;

      if (actor.role === "trusted-admin") return;

      if (!action.readOnly && actor.role !== "writer") {
        return yield* new Action.Forbidden({ scopes: ["users:write"] });
      }
    });

  /** The admin CLI, recording each rename. */
  const cli = () => {
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

    const admin: TrustedActor = { id: "maintenance", role: "trusted-admin" };

    const command = ActionCli.make(app, { name: "admin", actions: [Rename] }).pipe(
      Command.provideSync(Actor, admin),
    );

    return { calls, command };
  };

  it.effect("passes the same authorizer and handlers, with no policy override", () =>
    Effect.gen(function* () {
      const { calls, command } = cli();

      const [exit, stdout] = yield* printed(exec(command, ["rename-user", "--name", "Admin"]));

      expect(exit._tag).toBe("Success");
      expect(stdout.join("\n")).toContain('"caller": "maintenance"');
      expect(calls).toEqual(["maintenance"]);
    }),
  );
});
