import { describe, expect, it } from "@effect/vitest";
import { NodeHttpServer } from "@effect/platform-node";
import {
  Cause,
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
import { HttpRouter, HttpServerRequest } from "effect/http";
import { layer as host } from "../examples/app.js";
import { actors, CurrentActor } from "../examples/authorization.js";
import { Http } from "../examples/binding.js";
import { GetUser, RenameUser, Status, WhoAmI } from "../examples/contracts.js";
import { status, userActions } from "../examples/handlers.js";
import { layer as http } from "../examples/http.js";
import { layer as mcp } from "../examples/mcp.js";
import { Users } from "../examples/users.js";
import * as Action from "../src/Action.js";
import * as ActionHttp from "../src/ActionHttp.js";
import * as ActionMcp from "../src/ActionMcp.js";
import * as ActionToolkit from "../src/ActionToolkit.js";
import * as Testing from "../src/Testing.js";
import { httpProtocol } from "../src/internal/mcp.js";
import { as, mcpRequest, post, rawToolCall, valueOf } from "./requests.js";
import { serve, serveWithContext } from "./serve.js";
import { converse } from "./stdio-host.js";

describe("the identity authentication provides", () => {
  // An action reading the caller as an ordinary request service: public, so no
  // authentication covers it.
  const Caller = Action.make("caller", {
    description: "Name the caller.",
    access: "read",
    auth: "public",
    success: Schema.String,
  });

  const caller = Action.implement(Caller, () => Effect.map(CurrentActor, ({ id }) => id));

  const Public = ActionHttp.make([Caller], { prefix: "/public" });

  const uncovered = Layer.mergeAll(
    ActionHttp.layer(Public, caller),
    ActionMcp.layerHttp(caller, { name: "public", version: "0", path: "/mcp/caller" }),
  );

  it.effect(
    "wins over a caller provided around Testing.layer, which reaches only the public routes",
    () =>
      Effect.gen(function* () {
        // One caller for the routes no authentication covers, and tokens for the rest.
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

          // The authorizer reads the identity too: alice may write, where the reader may not.
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
        // The documented mistake: an identity at the root of the server, as for a background job.
        const server = HttpRouter.serve(host, { disableLogger: true, disableListenLog: true }).pipe(
          Layer.provide(Layer.succeed(CurrentActor, actors.bob)),
          Layer.provideMerge(NodeHttpServer.layerTest),
        );

        const users = yield* Effect.gen(function* () {
          const http = yield* ActionHttp.client(Http, as("alice"));
          const mcp = yield* Testing.mcpClient([GetUser], as("alice"));

          return [yield* http.getUser({ id: "1" }), yield* mcp.getUser({ id: "1" })];
        }).pipe(Effect.provide(server));

        // Alice's tenant's user, never the one of bob's tenant.
        expect(users).toEqual([
          { id: "1", name: "Ada" },
          { id: "1", name: "Ada" },
        ]);
      }),
  );

  it("never stands in for authentication: a caller presenting no token is refused", async () => {
    // A startup identity owes no verifier, so the routes still authenticate every request.
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

      // One client, a caller per call: each reads its own tenant's user.
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

      // A caller provided around another is never widened to the enclosing one.
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
    access: "read",
    auth: "public",
    success: Schema.String,
  });

  const where = Action.implement(Where, () => Tenant);

  const routes = Layer.mergeAll(
    ActionHttp.layer(ActionHttp.make([Where]), where),
    ActionMcp.layerHttp(where, { name: "test", version: "0" }),
  );

  // A tenant resolved from each request, as a host's own middleware would.
  const fromHeader = HttpRouter.middleware<{ provides: Tenant }>()((route) =>
    Effect.flatMap(HttpServerRequest.HttpServerRequest, (request) =>
      Effect.provideService(route, Tenant, request.headers["x-tenant"] ?? "none"),
    ),
  );

  it.each([
    [
      "HttpRouter.provideRequest",
      routes.pipe(HttpRouter.provideRequest(Layer.succeed(Tenant, "request"))),
    ],
    ["router middleware", routes.pipe(Layer.provide(fromHeader.layer))],
  ])("by %s wins over the value the routes were built with", async (_, provided) => {
    // A startup default under the same tag, for whatever else the host runs.
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
        access: "read",
        auth: Actor,
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

      // Public, reading the caller the host's own middleware provides each request.
      const Chat = Action.make("chat", {
        description: "Call a tool as a narrower delegate of the caller.",
        access: "read",
        auth: "public",
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
    access: "read",
    auth: "public",
    success: Schema.String,
  });

  const Boom = Action.make("boom", { description: "Die.", access: "write", auth: "public" });

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
    "yields to what the server runs in, unless HttpRouter.provideRequest gives it to its requests, over %s",
    (transport) =>
      Effect.gen(function* () {
        const Stage = Context.Reference<string>("request-context/Stage", {
          defaultValue: () => "default",
        });

        const Probe = Action.make("probe", {
          description: "Name the stage and the log level.",
          access: "read",
          auth: "public",
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

        // One surface is built with its own stage, the other gets a stage and a log level with
        // each request. The native MCP server drops the log level from the context it registers
        // tools in, so only an ordinary reference shows whether that context is laid over calls.
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
          // What the server runs in, as values provided around `HttpRouter.serve` are.
          Effect.provideService(Stage, "server"),
          Effect.provideService(References.CurrentLogLevel, "Warn"),
        );

        expect(answers).toEqual([
          { stage: "server", level: "Warn" },
          { stage: "scoped", level: "Debug" },
        ]);
      }),
  );

  it.each(["HTTP", "MCP"] as const)(
    "reports a handler's defect to their error reporters, once, over %s",
    async (transport) => {
      const reported: Array<string> = [];

      // Written out, it records every report: one `ErrorReporter.make` builds skips a cause
      // or a defect it has seen, so a second report would go unnoticed.
      const reporter: ErrorReporter.ErrorReporter = {
        [ErrorReporter.TypeId]: ErrorReporter.TypeId,
        report: ({ cause }) => void reported.push(Cause.pretty(cause)),
      };

      const boom = Action.implement(Boom, () => Effect.die(new Error("boom")));

      const routes =
        transport === "HTTP"
          ? ActionHttp.layer(ActionHttp.make([Boom]), boom)
          : ActionMcp.layerHttp(boom, { name: "test", version: "0" });

      const web = serve(routes.pipe(Layer.provide(ErrorReporter.layer([reporter]))));

      await web.handler(transport === "HTTP" ? post("/api/boom") : rawToolCall("boom"));

      expect(reported).toEqual([expect.stringContaining("Error: boom")]);
    },
  );

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

      // Each request carries the recording tracer; the routes are built in a span of their own.
      const web = serveWithContext(routes.pipe(Layer.withSpan("startup")));
      const context = Context.make(Tracer.Tracer, tracer);

      await web.handler(transport === "HTTP" ? post("/api/level") : rawToolCall("level"), context);

      expect(parents.get("level")).toMatch(
        transport === "HTTP" ? /^http\.server POST$/ : /^McpServer\..*tools\/call$/,
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
        access: "read",
        auth: Actor,
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
