import { describe, expect, it } from "@effect/vitest";
import {
  Cause,
  Context,
  Effect,
  Exit,
  Latch,
  Layer,
  Option,
  Predicate,
  Schema,
  SchemaIssue,
  Stream,
} from "effect";
import { Command } from "effect/cli";
import { McpServer } from "effect/ai";
import { HttpRouter } from "effect/http";
import * as Action from "../src/Action.js";
import * as ActionCli from "../src/ActionCli.js";
import * as ActionHttp from "../src/ActionHttp.js";
import * as ActionMcp from "../src/ActionMcp.js";
import * as ActionToolkit from "../src/ActionToolkit.js";
import * as Authentication from "../src/Authentication.js";
import * as Testing from "../src/Testing.js";
import { causeOf, exec, printed } from "./cli-services.js";
import { mcpRequest, post, rawToolCall, send } from "./requests.js";
import { serve } from "./serve.js";

class Scopes extends Context.Service<Scopes, ReadonlyArray<string>>()("access-test/Scopes") {}

class Caller extends Context.Service<Caller, string>()("access-test/Caller") {}

/** Authentication accepting every request: what OAuth step-up answers under. */
const anyone = Authentication.make(Caller, Effect.succeed(Effect.succeed("anyone"))).layer;

const Read = Action.make("read", {
  description: "Read the resource",
  access: "read",
  success: Schema.String,
});

const Write = Action.make("write", {
  description: "Change the resource",
  access: "write",
  input: { value: Schema.String },
  success: Schema.String,
});

// The hook answers instead of a handler with a built-in refusal, which every endpoint
// declares, so the binding needs no errors of its own.
const Http = ActionHttp.make([Read, Write]);

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

/** A fresh implementation per test, with the hook and handler invocations it recorded. */
const make = () => {
  const hooks: Array<string> = [];
  const handlers: Array<string> = [];
  const record = (name: string) => Effect.sync(() => (handlers.push(name), `${name} ok`));

  return {
    hooks,
    handlers,
    app: Action.implement(
      [Read, Write],
      {
        read: () => record("read"),
        write: () => record("write"),
      },
      authorize(hooks),
    ),
  };
};

const readOnly = Layer.succeed(Scopes, ["read"]);

type App = ReturnType<typeof make>["app"];

/** Serve the actions over HTTP, granting `granted` to every request. */
const serveHttp = (app: App, granted: Layer.Layer<Scopes>) =>
  serve(ActionHttp.layer(Http, app).pipe(HttpRouter.provideRequest(granted)));

describe("action access", () => {
  it("refuses a value the contract does not define, so plain JavaScript cannot skip a rule", () => {
    expect(() =>
      Action.make("unclassified", {
        description: "Classified by nobody",
        // @ts-expect-error The check exists for callers the compiler never sees.
        access: "admin",
        success: Schema.String,
      }),
    ).toThrow("Invalid access: admin");
  });
});

describe("the pre-handler hook", () => {
  it("runs once before each handler over HTTP and answers as a built-in refusal", async () => {
    const { app, hooks, handlers } = make();
    const web = serveHttp(app, readOnly);

    const allowed = await web.handler(post("/api/read"));
    expect(allowed.status).toBe(200);
    expect(await allowed.json()).toBe("read ok");

    const refused = await web.handler(post("/api/write", { value: "x" }));
    expect(refused.status).toBe(403);
    // The body is the refusal, encoded by its own schema like a handler's error.
    expect(await refused.json()).toEqual(
      Schema.encodeSync(Action.Forbidden)(new Action.Forbidden({ message: "Requires write." })),
    );

    expect(hooks).toEqual(["read", "write"]);
    expect(handlers).toEqual(["read"]);
  });

  it("decodes HTTP input before running either the hook or handler", async () => {
    const { app, hooks, handlers } = make();
    const web = serveHttp(app, readOnly);

    const invalid = await web.handler(post("/api/write", { value: 42 }));
    expect(invalid.status).toBe(400);
    expect(hooks).toEqual([]);
    expect(handlers).toEqual([]);

    const refused = await web.handler(post("/api/write", { value: "x" }));
    expect(refused.status).toBe(403);
    expect(hooks).toEqual(["write"]);
    expect(handlers).toEqual([]);
  });

  it("runs over MCP, where a refusal is the tool's declared failure", async () => {
    const { app, hooks, handlers } = make();

    const mcp = serve(
      ActionMcp.layerHttp(app, { name: "test", version: "0" }).pipe(
        HttpRouter.provideRequest(readOnly),
      ),
    );

    expect(await (await mcp.handler(rawToolCall("read"))).json()).toMatchObject({
      result: { isError: false, structuredContent: "read ok" },
    });
    expect(await (await mcp.handler(rawToolCall("write", { value: "x" }))).json()).toMatchObject({
      result: {
        isError: true,
        content: [{ type: "text", text: '{"_tag":"Forbidden","message":"Requires write."}' }],
      },
    });

    expect(hooks).toEqual(["read", "write"]);
    expect(handlers).toEqual(["read"]);
  });

  it("answers a refusal a client steps up on with its HTTP status under authentication, a hook's or a handler's", async () => {
    const needsWrite = new Action.Forbidden({ message: "Needs write.", scopes: ["write"] });

    const Hooked = Action.make("hooked", { description: "Refused by its hook", access: "write" });

    const Handled = Action.make("handled", {
      description: "Refused by its handler",
      access: "write",
    });

    const Plain = Action.make("plain", {
      description: "Refused by its hook, naming no scope",
      access: "write",
    });

    const app = Action.implement(
      [Hooked, Handled, Plain],
      {
        hooked: () => Effect.void,
        handled: () => Effect.fail(needsWrite),
        plain: () => Effect.void,
      },
      (action) =>
        action === Handled
          ? Effect.void
          : Effect.fail(action === Hooked ? needsWrite : new Action.Forbidden()),
    );

    const web = serve(
      Layer.mergeAll(
        ActionHttp.layer(ActionHttp.make([Hooked, Handled, Plain]), app),
        ActionMcp.layerHttp(app, { name: "test", version: "0" }),
      ).pipe(Layer.provide(anyone)),
    );

    const calls = [
      post("/api/hooked"),
      post("/api/handled"),
      rawToolCall("hooked"),
      rawToolCall("handled"),
    ];

    for (const call of calls) {
      const refused = await web.handler(call);

      expect(refused.status).toBe(403);
      expect(refused.headers.get("www-authenticate")).toBe(
        'Bearer error="insufficient_scope", scope="write", error_description="Needs write."',
      );
      expect(await refused.json()).toEqual(Schema.encodeSync(Action.Forbidden)(needsWrite));
    }

    // A refusal naming no scope has no challenge: re-authorizing would not help.
    const plain = await web.handler(post("/api/plain"));
    expect(plain.status).toBe(403);
    expect(plain.headers.get("www-authenticate")).toBeNull();

    // Unauthenticated is a 401 over MCP too: a client authenticates on it.
    const { app: guarded } = make();

    const noScopes = HttpRouter.provideRequest(Layer.succeed(Scopes, []));

    const unauthenticated = await serve(
      ActionMcp.layerHttp(guarded, { name: "test", version: "0" }).pipe(
        Layer.provide(anyone),
        noScopes,
      ),
    ).handler(rawToolCall("read"));

    expect(unauthenticated.status).toBe(401);
    expect(await unauthenticated.json()).toEqual(
      Schema.encodeSync(Action.Unauthenticated)(
        new Action.Unauthenticated({ message: "Sign in." }),
      ),
    );

    // Without authentication there is no OAuth client to step up: HTTP answers the refusal
    // as it is, unchallenged, and over MCP the model reads a result.
    const open = await serve(
      ActionHttp.layer(ActionHttp.make([Hooked, Handled, Plain]), app),
    ).handler(post("/api/hooked"));

    expect(open.status).toBe(403);
    expect(open.headers.get("www-authenticate")).toBeNull();

    const result = await serve(
      ActionMcp.layerHttp(guarded, { name: "test", version: "0" }).pipe(noScopes),
    ).handler(rawToolCall("read"));

    expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({
      result: {
        isError: true,
        content: [
          {
            type: "text",
            text: JSON.stringify(
              Schema.encodeSync(Action.Unauthenticated)(
                new Action.Unauthenticated({ message: "Sign in." }),
              ),
            ),
          },
        ],
      },
    });
  });

  it("keeps each request's step-up refusal its own under concurrent calls", async () => {
    const Allowed = Action.make("allowed", { description: "Allowed", access: "read" });
    const Refused = Action.make("refused", { description: "Refused", access: "write" });

    const app = Action.implement(
      [Allowed, Refused],
      { allowed: () => Effect.sleep("1 millis"), refused: () => Effect.void },
      (action) =>
        action === Refused ? Effect.fail(new Action.Forbidden({ scopes: ["write"] })) : Effect.void,
    );

    const web = serve(
      Layer.mergeAll(
        ActionHttp.layer(ActionHttp.make([Allowed, Refused]), app),
        ActionMcp.layerHttp(app, { name: "test", version: "0" }),
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
      calls.map(async ([call]) => (await web.handler(call)).status),
    );

    expect(statuses).toEqual(calls.map(([, status]) => status));
  });

  it("answers a handler's step-up refusal as a tool result once its call has streamed", async () => {
    const Reporting = Action.make("reporting", {
      description: "Reports progress, then refuses",
      access: "write",
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
      Action.allowAll,
    );

    const mcp = serve(
      ActionMcp.layerHttp(app, { name: "test", version: "0" }).pipe(Layer.provide(anyone)),
    );

    const reply = await mcp.handler(
      mcpRequest({
        method: "tools/call",
        params: { name: "reporting", arguments: {}, _meta: { progressToken: "call" } },
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
      const { app, hooks, handlers } = make();

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

      expect(hooks).toEqual(["read", "write"]);
      expect(handlers).toEqual(["read"]);
    }),
  );

  it.effect("runs over the CLI, so a local caller supplies its services too", () =>
    Effect.gen(function* () {
      const { app, hooks, handlers } = make();

      const run = <Name extends string, Input, Services, E>(
        command: Command.Command<Name, Input, Services, E, Scopes>,
        argv: ReadonlyArray<string>,
      ) => printed(exec(command, argv)).pipe(Effect.provide(readOnly));

      const [read, output] = yield* run(ActionCli.command(app, Read), []);
      expect(read._tag).toBe("Success");
      expect(output).toEqual(['"read ok"']);

      const [refused] = yield* run(ActionCli.command(app, Write), ["--value", "x"]);

      expect(causeOf(refused)).toBeInstanceOf(Action.Forbidden);

      expect(hooks).toEqual(["read", "write"]);
      expect(handlers).toEqual(["read"]);
    }),
  );

  it("is bound per implementation, so implementations without it skip it", async () => {
    const hooks: Array<string> = [];
    const handlers: Array<string> = [];
    const record = (name: string) => Effect.sync(() => (handlers.push(name), `${name} ok`));
    const read = Action.implement(Read, () => record("read"), Action.allowAll);
    const write = Action.implement(Write, () => record("write"), authorize(hooks));

    // One layer: only the write implementation has the hook.
    const web = serve(
      ActionHttp.layer(Http, [read, write]).pipe(HttpRouter.provideRequest(readOnly)),
    );

    expect((await web.handler(post("/api/read"))).status).toBe(200);
    expect((await web.handler(post("/api/write", { value: "x" }))).status).toBe(403);
    expect(hooks).toEqual(["write"]);
    expect(handlers).toEqual(["read"]);
  });

  it.effect.each([
    [new Action.Unauthenticated(), 401],
    [new Action.Forbidden({ message: "Requires write." }), 403],
  ] as const)("answers its %s over HTTP with its status, and to the client", ([refusal, status]) =>
    Effect.gen(function* () {
      const response = yield* send(post("/api/write", { value: "x" }));
      expect(response.status).toBe(status);
      expect(yield* response.json).toEqual(
        Schema.encodeSync(Schema.Union([Action.Unauthenticated, Action.Forbidden]))(refusal),
      );
      // Only authentication challenges, and none covers these routes.
      expect(response.headers).not.toHaveProperty("www-authenticate");

      const client = yield* ActionHttp.client(Http);

      expect(yield* Effect.flip(client.write({ value: "x" }))).toEqual(refusal);
    }).pipe(
      Effect.provide(
        Testing.layer(
          ActionHttp.layer(
            Http,
            Action.implement(
              Write,
              ({ value }) => Effect.succeed(value),
              () => Effect.fail(refusal),
            ),
          ),
        ),
      ),
    ),
  );

  it.effect(
    "fails with an error the called action declares, answered as the action's own everywhere",
    () =>
      Effect.gen(function* () {
        class RateLimited extends Schema.TaggedError<RateLimited>()(
          "RateLimited",
          { retryAfter: Schema.Finite },
          { httpApiStatus: 429 },
        ) {}

        // One array, spread into each action the hook guards, so every surface declares it for each.
        const limits = [RateLimited] as const;

        const Ping = Action.make("ping", {
          description: "Ping",
          access: "read",
          success: Schema.String,
          errors: [...limits],
        });

        const Poke = Action.make("poke", {
          description: "Poke",
          access: "write",
          input: { value: Schema.String },
          success: Schema.String,
          errors: [...limits],
        });

        const limited = new RateLimited({ retryAfter: 30 });

        // Writes are over their quota; reads are not.
        const app = Action.implement(
          [Ping, Poke],
          { ping: () => Effect.succeed("pong"), poke: ({ value }) => Effect.succeed(value) },
          (action) => (action.access === "write" ? Effect.fail(limited) : Effect.void),
        );

        const Http = ActionHttp.make([Ping, Poke]);

        // Under authentication, which answers a step-up refusal itself: a limit is no refusal.
        const served = Testing.layer(
          Layer.mergeAll(
            ActionHttp.layer(Http, app),
            ActionMcp.layerHttp(app, { name: "test", version: "0" }),
          ).pipe(Layer.provide(anyone)),
        );

        yield* Effect.gen(function* () {
          expect((yield* send(post("/api/ping"))).status).toBe(200);

          // HTTP answers with the error's own status and JSON, and no challenge.
          const answered = yield* send(post("/api/poke", { value: "x" }));

          expect(answered.status).toBe(429);
          expect(answered.headers).not.toHaveProperty("www-authenticate");
          expect(yield* answered.json).toEqual(Schema.encodeSync(RateLimited)(limited));

          // MCP answers with a tool result the model reads, not an HTTP status.
          const result = yield* send(rawToolCall("poke", { value: "x" }));

          expect(result.status).toBe(200);
          expect(yield* result.json).toMatchObject({
            result: {
              isError: true,
              content: [{ type: "text", text: '{"_tag":"RateLimited","retryAfter":30}' }],
            },
          });

          // A remote command decodes it, as `ActionHttp.client` does: the cause of its `UserError`.
          const remote = yield* Effect.exit(exec(ActionCli.command(Http, Poke), ["--value", "x"]));

          expect(causeOf(remote)).toEqual(limited);
          expect(causeOf(remote)).toBeInstanceOf(RateLimited);
        }).pipe(Effect.provide(served));

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
      }),
  );

  it.effect("passes a declared error its schema checks asynchronously, as the handler's", () =>
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

      const Limited = Schema.TaggedStruct("Limited", { code: Code });
      const limited = yield* Limited.makeEffect({ code: "quota" });

      const Ping = Action.make("ping", { description: "Ping", access: "read", errors: [Limited] });

      const fromHandler = Action.implement(Ping, () => Effect.fail(limited), Action.allowAll);

      const fromHook = Action.implement(
        Ping,
        () => Effect.void,
        () => Effect.fail(limited),
      );

      for (const app of [fromHandler, fromHook]) {
        const client = yield* Action.client(app);

        expect(yield* Effect.flip(client.ping())).toEqual(limited);
      }
    }),
  );

  it.effect("keeps a declared hook failure's whole cause: its trace and a defect beside it", () =>
    Effect.gen(function* () {
      class RateLimited extends Schema.TaggedError<RateLimited>()("RateLimited", {}) {}

      const Ping = Action.make("ping", {
        description: "Ping",
        access: "read",
        errors: [RateLimited],
      });

      const cleanup = new Error("cleanup failed");

      // Refused in a span of its own, with a cleanup that dies.
      const app = Action.implement(
        Ping,
        () => Effect.void,
        () =>
          Effect.fail(new RateLimited()).pipe(
            Effect.ensuring(Effect.die(cleanup)),
            Effect.withSpan("quota"),
          ),
      );

      const client = yield* Action.client(app);
      const cause = yield* Effect.flip(Effect.sandbox(client.ping()));

      expect(cause.reasons.filter(Cause.isFailReason).map(({ error }) => error)).toEqual([
        new RateLimited(),
      ]);
      expect(cause.reasons.filter(Cause.isDieReason).map(({ defect }) => defect)).toEqual([
        cleanup,
      ]);
      expect(Cause.pretty(cause)).toMatch(/^\s+at quota \(.*access\.test\.ts/m);
    }),
  );

  it.effect(
    "makes a failure the called action does not declare a defect naming it, on every surface",
    () =>
      Effect.gen(function* () {
        class RateLimited extends Schema.TaggedError<RateLimited>()(
          "RateLimited",
          {},
          { httpApiStatus: 429 },
        ) {}

        const Ping = Action.make("ping", {
          description: "Ping",
          access: "read",
          errors: [RateLimited],
        });

        const Status = Action.make("status", { description: "Status", access: "read" });

        // Typed by the union of what the actions declare, a hook may fail with an error the
        // action it runs for leaves out.
        const app = Action.implement(
          [Ping, Status],
          { ping: () => Effect.void, status: () => Effect.void },
          () => Effect.fail(new RateLimited()),
        );

        const undeclared = new Error(
          'Action "status": its hook failed with an error the action does not declare: RateLimited',
        );

        /** What `exit` died with, if it did. */
        const defectOf = <A, E>(exit: Exit.Exit<A, E>) =>
          Exit.isFailure(exit) && Cause.hasDies(exit.cause) ? Cause.squash(exit.cause) : undefined;

        // In process: `Action.client`, the Toolkit and a local command.
        const called = yield* Effect.exit(
          Effect.flatMap(Action.client(app), (client) => client.status()),
        );

        expect(defectOf(called)).toEqual(undeclared);

        const tools = ActionToolkit.make(app);

        const handled = yield* Effect.exit(
          Effect.gen(function* () {
            const toolkit = yield* tools.toolkit;

            return yield* Stream.runCollect(yield* toolkit.handle("status", {}));
          }).pipe(Effect.provide(tools.layer)),
        );

        expect(defectOf(handled)).toEqual(undeclared);

        const local = yield* Effect.exit(exec(ActionCli.command(app, Status), []));

        expect(defectOf(local)).toEqual(undeclared);

        const Http = ActionHttp.make([Ping, Status]);

        yield* Effect.gen(function* () {
          // Over HTTP and MCP, the action that declares it answers with it; the other, as a defect.
          expect((yield* send(post("/api/ping"))).status).toBe(429);
          expect((yield* send(post("/api/status"))).status).toBe(500);

          expect(yield* (yield* send(rawToolCall("status"))).json).toMatchObject({
            result: {
              isError: true,
              content: [
                { type: "text", text: "Tool execution failed due to an internal server error." },
              ],
            },
          });
        }).pipe(
          Effect.provide(
            Testing.layer(
              Layer.mergeAll(
                ActionHttp.layer(Http, app),
                ActionMcp.layerHttp(app, { name: "test", version: "0" }),
              ),
            ),
          ),
        );
      }),
  );
});
