import { describe, expect, it } from "@effect/vitest";
import { NodeHttpServer } from "@effect/platform-node";
import {
  Context,
  Effect,
  ErrorReporter,
  Layer,
  Option,
  References,
  Schema,
  Stream,
  Tracer,
} from "effect";
import { HttpClient, HttpRouter, HttpServerRequest } from "effect/http";
import { RpcClient, RpcSerialization, RpcServer } from "effect/rpc";
import { layer as host } from "../../examples/app.js";
import { actors, CurrentActor } from "../../examples/authorization.js";
import { Http } from "../../examples/binding.js";
import { GetUser, RenameUser, Status, WhoAmI } from "../../examples/contracts.js";
import { status, userActions } from "../../examples/handlers.js";
import { layer as http } from "../../examples/http.js";
import { layer as mcp } from "../../examples/mcp.js";
import { Users } from "../../examples/users.js";
import * as Action from "../../src/contract/Action.js";
import * as ActionHttp from "../../src/http/ActionHttp.js";
import * as ActionMcp from "../../src/mcp/ActionMcp.js";
import * as ActionRpc from "../../src/rpc/ActionRpc.js";
import * as ActionToolkit from "../../src/toolkit/ActionToolkit.js";
import type { Served } from "../../src/testing/memory.js";
import * as Testing from "../../src/testing/Testing.js";
import { httpProtocol } from "../../src/mcp/protocol.js";
import { as, mcpRequest, post, rawToolCall, send, valueOf } from "../support/requests.js";
import { recorder } from "../support/reporter.js";
import { serve, serveWithContext } from "../support/serve.js";
import { converse } from "../support/stdio-host.js";

describe("the identity authentication provides", () => {
  const Caller = Action.make("caller", {
    description: "Name the caller.",
    readOnly: true,
    caller: Action.Anyone,
    success: Schema.String,
  });

  const caller = Action.implement(Caller, () => Effect.map(CurrentActor, ({ id }) => id));

  const Public = ActionHttp.make([Caller], { prefix: "/public" });

  const uncovered = Layer.mergeAll(
    ActionHttp.layer(Public, caller),
    ActionMcp.layerHttp(caller, { name: "public", version: "0", path: "/mcp/caller" }),
  );

  it.effect(
    "wins over a caller provided around Testing.layer, which reaches only the public routes, for handlers and authorizers alike",
    () =>
      Effect.gen(function* () {
        const harness = Testing.layer(Layer.mergeAll(host, uncovered)).pipe(
          Layer.provide(Layer.succeed(CurrentActor, actors.reader)),
        );

        const answered = yield* Effect.gen(function* () {
          const http = yield* ActionHttp.client(Http, as("alice"));
          const mcp = yield* Testing.mcpClient([WhoAmI, RenameUser], as("alice"));

          const identities = {
            http: (yield* http.whoAmI()).id,
            mcp: (yield* mcp.whoAmI()).id,
          };

          const renamed = [
            yield* http.renameUser({ id: "1", name: "Bea" }),
            yield* mcp.renameUser({ id: "1", name: "Cy" }),
          ];

          const anonymous = {
            http: yield* Effect.flatMap(ActionHttp.client(Public), (client) => client.caller()),
            mcp: yield* Effect.flatMap(Testing.mcpClient([Caller], { url: "/mcp/caller" }), (mcp) =>
              mcp.caller(),
            ),
          };

          return { identities, renamed, anonymous };
        }).pipe(Effect.provide(harness));

        expect(answered).toEqual({
          identities: { http: "alice", mcp: "alice" },
          renamed: [
            { id: "1", name: "Bea" },
            { id: "1", name: "Cy" },
          ],
          anonymous: { http: "reader", mcp: "reader" },
        });
      }),
  );

  it.effect(
    "wins over an identity provided at a server's startup, so a caller reads its own tenant",
    () =>
      Effect.gen(function* () {
        const server = HttpRouter.serve(host, { disableLogger: true, disableListenLog: true }).pipe(
          Layer.provide(Layer.succeed(CurrentActor, actors.bob)),
          Layer.provideMerge(NodeHttpServer.layerTest),
        );

        const users = yield* Effect.gen(function* () {
          const http = yield* ActionHttp.client(Http, as("alice"));
          const mcp = yield* Testing.mcpClient([GetUser], as("alice"));

          return [yield* http.getUser({ id: "1" }), yield* mcp.getUser({ id: "1" })];
        }).pipe(Effect.provide(server));

        expect(users).toEqual([
          { id: "1", name: "Ada" },
          { id: "1", name: "Ada" },
        ]);
      }),
  );

  it("never stands in for authentication: a caller presenting no token is refused", async () => {
    const web = serve(
      Layer.mergeAll(http, mcp).pipe(
        Layer.provide(Layer.succeed(CurrentActor, actors.alice)),
        Layer.provide(Users.layerMemory),
      ),
    );

    expect((await web.handler(post("/api/whoAmI"))).status).toBe(401);
    expect((await web.handler(rawToolCall("whoAmI"))).status).toBe(401);
  });
});

describe("the caller of a local surface", () => {
  it.effect("is read per call by Action.client, and a public selection needs none", () =>
    Effect.gen(function* () {
      const client = yield* Action.client(userActions, { actions: [GetUser, WhoAmI] });
      const whoAmI = client.whoAmI();

      expect(yield* whoAmI.pipe(Effect.provideService(CurrentActor, actors.alice))).toEqual({
        id: "alice",
        tenantId: "acme",
      });
      expect(yield* whoAmI.pipe(Effect.provideService(CurrentActor, actors.bob))).toEqual({
        id: "bob",
        tenantId: "other",
      });

      expect(
        yield* client.getUser({ id: "1" }).pipe(Effect.provideService(CurrentActor, actors.bob)),
      ).toEqual({ id: "1", name: "Grace" });

      const open = yield* Action.client([status, userActions], { actions: [Status] });

      expect(yield* open.status()).toEqual({ service: "effect-actions", users: 2 });
    }).pipe(Effect.provide(Users.layerMemory)),
  );

  it.effect("is read per call by one Toolkit, the innermost caller winning", () => {
    const binding = ActionToolkit.make(userActions, { actions: [WhoAmI] });

    return Effect.gen(function* () {
      const tools = yield* binding.toolkit;
      const call = Effect.flatMap(tools.handle("whoAmI", {}), Stream.runCollect);

      expect(yield* call.pipe(Effect.provideService(CurrentActor, actors.alice))).toMatchObject([
        { result: { id: "alice" } },
      ]);
      expect(yield* call.pipe(Effect.provideService(CurrentActor, actors.bob))).toMatchObject([
        { result: { id: "bob" } },
      ]);

      expect(
        yield* call.pipe(
          Effect.provideService(CurrentActor, actors.reader),
          Effect.provideService(CurrentActor, actors.alice),
        ),
      ).toMatchObject([{ result: { id: "reader" } }]);
    }).pipe(Effect.provide(binding.layer), Effect.provide(Users.layerMemory));
  });
});

describe("a value provided per request", () => {
  class Tenant extends Context.Service<Tenant, string>()("request-context/Tenant") {}

  const Where = Action.make("where", {
    description: "Name the request's tenant.",
    readOnly: true,
    caller: Action.Anyone,
    success: Schema.String,
  });

  const where = Action.implement(Where, () => Tenant);

  const routes = Layer.mergeAll(
    ActionHttp.layer(ActionHttp.make([Where]), where),
    ActionMcp.layerHttp(where, { name: "test", version: "0" }),
  );

  const tenantFromHeader = HttpRouter.middleware<{ provides: Tenant }>()((route) =>
    Effect.flatMap(HttpServerRequest.HttpServerRequest, (request) =>
      Effect.provideService(route, Tenant, request.headers["x-tenant"] ?? "none"),
    ),
  );

  it.each([
    [
      "HttpRouter.provideRequest",
      routes.pipe(HttpRouter.provideRequest(Layer.succeed(Tenant, "request"))),
    ],
    ["router middleware", routes.pipe(Layer.provide(tenantFromHeader.layer))],
  ])("by %s wins over the value the routes were built with", async (_, provided) => {
    const web = serve(provided.pipe(Layer.provide(Layer.succeed(Tenant, "startup"))));

    const http = post("/api/where");
    http.headers.set("x-tenant", "request");

    const mcp = mcpRequest({
      method: "tools/call",
      params: { name: "where", arguments: {} },
      headers: { "x-tenant": "request" },
    });

    expect(await (await web.handler(http)).json()).toBe("request");
    expect(await valueOf(await web.handler(mcp))).toBe("request");
  });

  it.each(["HTTP", "MCP"] as const)(
    "is still the one a handler gives a Toolkit call it makes, over %s",
    async (transport) => {
      class Actor extends Context.Service<Actor, string>()("request-context/Actor") {}

      const seen: Array<string> = [];

      const Who = Action.make("who", {
        description: "Record the caller.",
        readOnly: true,
        caller: Actor,
      });

      const who = Action.implement(
        Who,
        () => Effect.flatMap(Actor, (actor) => Effect.sync(() => seen.push(`handler: ${actor}`))),
        {
          authorize: () =>
            Effect.flatMap(Actor, (actor) =>
              Effect.sync(() => void seen.push(`authorizer: ${actor}`)),
            ),
        },
      );

      const tools = ActionToolkit.make(who);

      const Chat = Action.make("chat", {
        description: "Call a tool as a narrower delegate of the caller.",
        readOnly: true,
        caller: Action.Anyone,
      });

      const chat = Action.implement(
        Chat,
        Effect.map(
          tools.toolkit,
          (toolkit) => () =>
            Effect.flatMap(Actor, (actor) =>
              toolkit
                .handle("who", {})
                .pipe(
                  Effect.flatMap(Stream.runDrain),
                  Effect.orDie,
                  Effect.provideService(Actor, `delegate of ${actor}`),
                ),
            ),
        ),
      );

      const identify = HttpRouter.middleware<{ provides: Actor }>()((route) =>
        Effect.provideService(route, Actor, "alice"),
      );

      const routes =
        transport === "HTTP"
          ? ActionHttp.layer(ActionHttp.make([Chat]), chat)
          : ActionMcp.layerHttp(chat, { name: "test", version: "0" });

      const web = serve(routes.pipe(Layer.provide(tools.layer), Layer.provide(identify.layer)));

      const response = await web.handler(
        transport === "HTTP" ? post("/api/chat") : rawToolCall("chat"),
      );

      expect(response.status).toBe(200);
      expect(seen).toEqual(["authorizer: delegate of alice", "handler: delegate of alice"]);
    },
  );
});

describe("what the routes were built with", () => {
  const Level = Action.make("level", {
    description: "Name the current log level.",
    readOnly: true,
    caller: Action.Anyone,
    success: Schema.String,
  });

  const Boom = Action.make("boom", { description: "Die.", readOnly: false, caller: Action.Anyone });

  it("fills in a reference a request lacks, but never the log level an MCP client asks for", async () => {
    const level = Action.implement(Level, () => Effect.service(References.CurrentLogLevel));

    const web = serve(
      Layer.mergeAll(
        ActionHttp.layer(ActionHttp.make([Level]), level),
        ActionMcp.layerHttp(level, { name: "test", version: "0" }),
      ).pipe(Layer.provide(Layer.succeed(References.CurrentLogLevel, "Warn"))),
    );

    const call = (meta: { readonly [key: string]: Schema.Json }) =>
      web.handler(
        mcpRequest({ method: "tools/call", params: { name: "level", arguments: {}, _meta: meta } }),
      );

    expect(await (await web.handler(post("/api/level"))).json()).toBe("Warn");
    expect(await valueOf(await call({}))).toBe("Warn");
    expect(await valueOf(await call({ "io.modelcontextprotocol/logLevel": "debug" }))).toBe(
      "Debug",
    );
  });

  it.effect.each(["HTTP", "MCP"] as const)(
    "yields to what the server runs in, unless HttpRouter.provideRequest gives it to its requests, shown by an ordinary reference, since the native MCP server drops the log level from the context it registers tools in, over %s",
    (transport) =>
      Effect.gen(function* () {
        const Stage = Context.Reference<string>("request-context/Stage", {
          defaultValue: () => "default",
        });

        const Probe = Action.make("probe", {
          description: "Name the stage and the log level.",
          readOnly: true,
          caller: Action.Anyone,
          success: { stage: Schema.String, level: Schema.String },
        });

        const probe = Action.implement(Probe, () =>
          Effect.all({
            stage: Effect.service(Stage),
            level: Effect.service(References.CurrentLogLevel),
          }),
        );

        const bindings = {
          "/built": ActionHttp.make([Probe], { prefix: "/built" }),
          "/scoped": ActionHttp.make([Probe], { prefix: "/scoped" }),
        };

        const surface = (path: keyof typeof bindings) =>
          transport === "HTTP"
            ? ActionHttp.layer(bindings[path], probe)
            : ActionMcp.layerHttp(probe, { name: "test", version: "0", path });

        const routes = Layer.mergeAll(
          surface("/built").pipe(Layer.provide(Layer.succeed(Stage, "built"))),
          surface("/scoped").pipe(
            HttpRouter.provideRequest(
              Layer.mergeAll(
                Layer.succeed(Stage, "scoped"),
                Layer.succeed(References.CurrentLogLevel, "Debug"),
              ),
            ),
          ),
        );

        const probeAt = (path: keyof typeof bindings) =>
          transport === "HTTP"
            ? Effect.flatMap(ActionHttp.client(bindings[path]), (client) => client.probe())
            : Effect.flatMap(Testing.mcpClient([Probe], { url: path }), (mcp) => mcp.probe());

        const answers = yield* Effect.all([probeAt("/built"), probeAt("/scoped")]).pipe(
          Effect.provide(Testing.layer(routes)),
          Effect.provideService(Stage, "server"),
          Effect.provideService(References.CurrentLogLevel, "Warn"),
        );

        expect(answers).toEqual([
          { stage: "server", level: "Warn" },
          { stage: "scoped", level: "Debug" },
        ]);
      }),
  );

  const boom = Action.implement(Boom, () => Effect.die(new Error("boom")));

  const boomOver: Record<
    "HTTP" | "MCP" | "RPC",
    {
      readonly routes: Layer.Layer<never, unknown, Served>;
      readonly call: Effect.Effect<unknown, unknown, HttpClient.HttpClient>;
    }
  > = {
    HTTP: {
      routes: ActionHttp.layer(ActionHttp.make([Boom]), boom),
      call: Effect.suspend(() => send(post("/api/boom"))),
    },
    MCP: {
      routes: ActionMcp.layerHttp(boom, { name: "test", version: "0" }),
      call: Effect.suspend(() => send(rawToolCall("boom"))),
    },
    RPC: {
      routes: ActionRpc.layer(ActionRpc.make([Boom]), boom).pipe(
        Layer.provide(RpcServer.layerProtocolHttp({ path: "/rpc" })),
        Layer.provide(RpcSerialization.layerJson),
      ),
      call: Effect.flatMap(ActionRpc.client(ActionRpc.make([Boom])), (client) =>
        Effect.exit(client.boom()),
      ).pipe(
        Effect.scoped,
        Effect.provide(
          RpcClient.layerProtocolHttp({ url: "/rpc" }).pipe(
            Layer.provide(RpcSerialization.layerJson),
          ),
        ),
      ),
    },
  };

  it.effect.each(["HTTP", "MCP", "RPC"] as const)(
    "reports a handler's defect to their error reporters, once, over %s",
    (transport) =>
      Effect.gen(function* () {
        const reported: Array<string> = [];
        const { routes, call } = boomOver[transport];

        yield* call.pipe(
          Effect.provide(
            Testing.layer(routes.pipe(Layer.provide(ErrorReporter.layer([recorder(reported)])))),
          ),
        );

        expect(reported).toEqual([expect.stringContaining("Error: boom")]);
      }),
  );

  it.effect.each(["HTTP", "MCP", "RPC"] as const)(
    "reports a defect to the server's error reporters over the layer's, over %s",
    (transport) =>
      Effect.gen(function* () {
        const layer: Array<string> = [];
        const server: Array<string> = [];
        const { routes, call } = boomOver[transport];

        yield* call.pipe(
          Effect.provide(
            Testing.layer(routes.pipe(Layer.provide(ErrorReporter.layer([recorder(layer)])))).pipe(
              Layer.provide(
                ErrorReporter.layer([
                  ErrorReporter.make(({ error }) => void server.push(String(error))),
                ]),
              ),
            ),
          ),
        );

        expect(layer).toEqual([]);
        expect(server).toEqual(["Error: boom"]);
      }),
  );

  it("answers a success that does not encode with an empty 500, reported once, over HTTP", async () => {
    const reported: Array<string> = [];

    const Count = Action.make("count", {
      description: "Count.",
      readOnly: true,
      caller: Action.Anyone,
      success: Schema.Finite,
    });

    const count = Action.implement(Count, () => Effect.succeed(Infinity));

    const web = serve(
      ActionHttp.layer(ActionHttp.make([Count]), count).pipe(
        Layer.provide(ErrorReporter.layer([recorder(reported)])),
      ),
    );

    const response = await web.handler(post("/api/count"));

    expect(response.status).toBe(500);
    expect(await response.text()).toBe("");
    expect(reported).toEqual([expect.stringContaining("Expected a finite number")]);
  });

  it.each(["HTTP", "MCP"] as const)(
    "never replaces the request span as the action span's parent, over %s",
    async (transport) => {
      const parents = new Map<string, string | undefined>();

      const tracer = Tracer.make({
        span(options) {
          const parent = Option.getOrUndefined(options.parent);

          parents.set(options.name, parent?._tag === "Span" ? parent.name : undefined);

          return Tracer.nativeTracer.span(options);
        },
      });

      const level = Action.implement(Level, () => Effect.succeed("ok"));

      const routes =
        transport === "HTTP"
          ? ActionHttp.layer(ActionHttp.make([Level]), level)
          : ActionMcp.layerHttp(level, { name: "test", version: "0" });

      const web = serveWithContext(routes.pipe(Layer.withSpan("startup")));
      const context = Context.make(Tracer.Tracer, tracer);

      await web.handler(transport === "HTTP" ? post("/api/level") : rawToolCall("level"), context);

      expect(parents.get("level")).toMatch(
        transport === "HTTP" ? /^POST$/ : /^McpServer\..*tools\/call$/,
      );
    },
  );
});

describe("over stdio", () => {
  it.effect("gives a tool call the identity the host provides around runStdio", () =>
    Effect.gen(function* () {
      class Actor extends Context.Service<Actor, string>()("request-context/StdioActor") {}

      const Who = Action.make("who", {
        description: "Name the caller.",
        readOnly: true,
        caller: Actor,
        success: Schema.String,
      });

      const authorized: Array<string> = [];

      const who = Action.implement(Who, () => Actor, {
        authorize: () =>
          Effect.flatMap(Actor, (actor) => Effect.sync(() => void authorized.push(actor))),
      });

      const [answer] = yield* converse(
        ActionMcp.runStdio(who, { name: "test", version: "0" }).pipe(
          Effect.provideService(Actor, "host"),
        ),
        httpProtocol.protocolVersion,
        [{ method: "tools/call", params: { name: "who", arguments: {} } }],
      );

      expect(JSON.parse(answer ?? "")).toMatchObject({ result: { structuredContent: "host" } });
      expect(authorized).toEqual(["host"]);
    }),
  );
});
