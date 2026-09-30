import { describe, expect, it } from "vite-plus/test";
import { Context, Effect, Latch, Layer, Option, Schema, Stream } from "effect";
import { Command } from "effect/cli";
import { McpServer } from "effect/ai";
import { HttpRouter } from "effect/http";
import * as Action from "../src/Action.js";
import * as ActionCli from "../src/ActionCli.js";
import * as ActionHttp from "../src/ActionHttp.js";
import * as ActionMcp from "../src/ActionMcp.js";
import * as ActionToolkit from "../src/ActionToolkit.js";
import * as Authentication from "../src/Authentication.js";
import { causeOf, cliServices, logged } from "./cli-services.js";
import { mcpRequest, post, rawToolCall } from "./requests.js";
import { clientLayer, httpClient, serve } from "./serve.js";

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
  it("is declared by every action, and is the only source of a tool's read-only hint", () => {
    const read: "read" = Read.access;
    const write: "write" = Write.access;

    expect([read, write]).toEqual(["read", "write"]);
    expect(Read.hints).toMatchObject({ destructive: false });
    expect(Write.hints).toMatchObject({ destructive: true });

    Action.make("advertised", {
      description: "A write the model may call without approval",
      access: "write",
      success: Schema.String,
      // @ts-expect-error A tool is read-only exactly when its action reads.
      hints: { readOnly: true },
    });
  });

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

    const app = Action.implement(
      [Hooked, Handled],
      { hooked: () => Effect.void, handled: () => Effect.fail(needsWrite) },
      (action) => (action === Hooked ? Effect.fail(needsWrite) : Effect.void),
    );

    const web = serve(
      Layer.mergeAll(
        ActionHttp.layer(ActionHttp.make([Hooked, Handled]), app),
        ActionMcp.layerHttp(app, { name: "test", version: "0" }),
      ).pipe(Layer.provide(anyone)),
    );

    // The routing header encoded as MCP allows, which the native server accepts.
    const encoded = rawToolCall("hooked");
    encoded.headers.set("mcp-name", `=?base64?${btoa("hooked")}?=`);

    const calls = [
      post("/api/hooked"),
      post("/api/handled"),
      rawToolCall("hooked"),
      rawToolCall("handled"),
      encoded,
    ];

    for (const call of calls) {
      const refused = await web.handler(call);

      expect(refused.status).toBe(403);
      expect(refused.headers.get("www-authenticate")).toBe(
        'Bearer error="insufficient_scope", scope="write", error_description="Needs write."',
      );
      expect(await refused.json()).toEqual(Schema.encodeSync(Action.Forbidden)(needsWrite));
    }

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

    // Without authentication there is no OAuth client to step up: the model reads a result.
    const result = await serve(
      ActionMcp.layerHttp(guarded, { name: "test", version: "0" }).pipe(noScopes),
    ).handler(rawToolCall("read"));

    expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({ result: { isError: true } });
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
          const server = yield* Effect.serviceOption(McpServer.McpServer);

          if (Option.isSome(server)) {
            yield* server.value.notifications["notifications/progress"]({
              progressToken: "call",
              progress: 1,
            });
          }

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
    Effect.runSync(streamed.open);

    const text = await reply.text();
    expect(text).toContain('"method":"notifications/progress"');
    expect(text).toContain('"isError":true');
    expect(text).toContain(String.raw`\"_tag\":\"Forbidden\"`);
  });

  it("runs over the native Toolkit", async () => {
    const { app, hooks, handlers } = make();

    const binding = ActionToolkit.make(app);

    const call = (name: "read" | "write") =>
      Effect.runPromise(
        Effect.gen(function* () {
          const tools = yield* binding.toolkit;

          return yield* Stream.runCollect(
            yield* tools.handle(name, name === "write" ? { value: "x" } : {}),
          );
        }).pipe(Effect.provide(binding.layer), Effect.provide(readOnly)),
      );

    expect(await call("read")).toMatchObject([{ isFailure: false, result: "read ok" }]);

    const refused = await call("write");
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
  });

  it("runs over the CLI, so a local caller supplies its services too", async () => {
    const { app, hooks, handlers } = make();

    const run = <Name extends string, Input, Services, E>(
      command: Command.Command<Name, Input, Services, E, Scopes>,
      argv: ReadonlyArray<string>,
    ) =>
      Effect.runPromise(
        logged(Command.runWith(command, { version: "0" })([...argv]).pipe(Effect.exit)).pipe(
          Effect.provide(cliServices),
          Effect.provide(readOnly),
        ),
      );

    const [read, output] = await run(ActionCli.command(app, Read), []);
    expect(read._tag).toBe("Success");
    expect(output).toEqual(['"read ok"']);

    const [refused] = await run(ActionCli.command(app, Write), ["--value", "x"]);

    expect(causeOf(refused)).toBeInstanceOf(Action.Forbidden);

    expect(hooks).toEqual(["read", "write"]);
    expect(handlers).toEqual(["read"]);
  });

  it("is skipped by no action of its implementation", async () => {
    const { app, hooks } = make();
    const web = serveHttp(app, Layer.succeed(Scopes, ["read", "write"]));

    expect((await web.handler(post("/api/write", { value: "x" }))).status).toBe(200);
    expect(hooks).toEqual(["write"]);
  });

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

  it.each([
    [new Action.Unauthenticated(), 401],
    [new Action.Forbidden({ message: "Requires write." }), 403],
  ] as const)(
    "answers its %s over HTTP with its status, and to the client",
    async (refusal, status) => {
      const web = serve(
        ActionHttp.layer(
          Http,
          Action.implement(
            Write,
            ({ value }) => Effect.succeed(value),
            () => Effect.fail(refusal),
          ),
        ),
      );

      const response = await web.handler(post("/api/write", { value: "x" }));
      expect(response.status).toBe(status);
      expect(await response.json()).toEqual(
        Schema.encodeSync(Schema.Union([Action.Unauthenticated, Action.Forbidden]))(refusal),
      );
      // Only authentication challenges, and none covers these routes.
      expect(response.headers.has("www-authenticate")).toBe(false);

      const refused = await Effect.runPromise(
        Effect.flip(
          Effect.flatMap(httpClient(Http, web), (client) => client.write({ value: "x" })),
        ),
      );

      expect(refused).toEqual(refusal);
    },
  );

  it("fails with an error every action it guards declares, answered as the action's own everywhere", async () => {
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
    const web = serve(
      Layer.mergeAll(
        ActionHttp.layer(Http, app),
        ActionMcp.layerHttp(app, { name: "test", version: "0" }),
      ).pipe(Layer.provide(anyone)),
    );

    expect((await web.handler(post("/api/ping"))).status).toBe(200);

    // HTTP answers with the error's own status and JSON, and no challenge.
    const answered = await web.handler(post("/api/poke", { value: "x" }));
    expect(answered.status).toBe(429);
    expect(answered.headers.get("www-authenticate")).toBeNull();
    expect(await answered.json()).toEqual(Schema.encodeSync(RateLimited)(limited));

    // MCP answers with a tool result the model reads, not an HTTP status.
    const result = await web.handler(rawToolCall("poke", { value: "x" }));
    expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({
      result: {
        isError: true,
        content: [{ type: "text", text: '{"_tag":"RateLimited","retryAfter":30}' }],
      },
    });

    // A remote command decodes it, as `ActionHttp.client` does: the cause of its `UserError`.
    const [remote] = await Effect.runPromise(
      logged(
        Command.runWith(ActionCli.command(Http, Poke), { version: "0" })(["--value", "x"]).pipe(
          Effect.exit,
        ),
      ).pipe(Effect.provide(clientLayer(web)), Effect.provide(cliServices)),
    );

    expect(causeOf(remote)).toEqual(limited);
    expect(causeOf(remote)).toBeInstanceOf(RateLimited);

    // The Toolkit returns it as the tool's failure.
    const tools = ActionToolkit.make(app);

    const returned = await Effect.runPromise(
      Effect.gen(function* () {
        const toolkit = yield* tools.toolkit;

        return yield* Stream.runCollect(yield* toolkit.handle("poke", { value: "x" }));
      }).pipe(Effect.provide(tools.layer)),
    );

    expect(returned).toMatchObject([
      {
        isFailure: true,
        result: limited,
        encodedResult: Schema.encodeSync(RateLimited)(limited),
      },
    ]);
    expect(returned[0]?.result).toBeInstanceOf(RateLimited);

    // A local command fails with Effect CLI's `UserError`, whose cause it is.
    const [local] = await Effect.runPromise(
      logged(
        Command.runWith(ActionCli.command(app, Poke), { version: "0" })(["--value", "x"]).pipe(
          Effect.exit,
        ),
      ).pipe(Effect.provide(cliServices)),
    );

    expect(causeOf(local)).toBeInstanceOf(RateLimited);
  });
});
