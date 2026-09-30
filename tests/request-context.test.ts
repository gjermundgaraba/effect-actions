import { describe, expect, it } from "vite-plus/test";
import { NodeHttpServer } from "@effect/platform-node";
import {
  Context,
  Deferred,
  Effect,
  ErrorReporter,
  Layer,
  Option,
  References,
  Schema,
  Sink,
  Stdio,
  Stream,
  Tracer,
} from "effect";
import {
  HttpClient,
  HttpClientRequest,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/http";
import { layer as host } from "../examples/app.js";
import { authenticate } from "../examples/authentication.js";
import { actors, CurrentActor } from "../examples/authorization.js";
import { Http } from "../examples/binding.js";
import { GetUser, RenameUser, WhoAmI } from "../examples/contracts.js";
import * as Action from "../src/Action.js";
import * as ActionHttp from "../src/ActionHttp.js";
import * as ActionMcp from "../src/ActionMcp.js";
import * as ActionToolkit from "../src/ActionToolkit.js";
import * as Testing from "../src/Testing.js";
import { statelessRequest } from "../src/internal/mcp.js";
import { withMcpClient } from "./mcp-client.js";
import { mcpRequest, post, rawToolCall } from "./requests.js";
import { serve, serveWithContext } from "./serve.js";

/** Client options sending `token`, a demo actor's name, as its bearer token. */
const as = (token: string) => ({
  transformClient: HttpClient.mapRequest(HttpClientRequest.bearerToken(token)),
});

/** A raw MCP tool call's response, holding the encoded success as its structured content. */
const McpSuccess = Schema.Struct({
  result: Schema.Struct({ structuredContent: Schema.Json }),
});

const valueOf = async (response: Response) =>
  Schema.decodeUnknownSync(McpSuccess)(await response.json()).result.structuredContent;

describe("the identity authentication provides", () => {
  // A native route under the example's authentication, reading the identity as handlers do.
  const native = HttpRouter.add(
    "POST",
    "/native/whoAmI",
    Effect.map(CurrentActor, ({ id }) => HttpServerResponse.text(id)),
  ).pipe(Layer.provide(authenticate));

  // An action reading the caller, served where no authentication covers it.
  const Caller = Action.make("caller", {
    description: "Name the caller.",
    access: "read",
    success: Schema.String,
  });

  const caller = Action.implement(Caller, () => Effect.map(CurrentActor, ({ id }) => id));

  const Public = ActionHttp.make([Caller], { prefix: "/public" });

  const uncovered = Layer.mergeAll(
    ActionHttp.layer(Public, caller),
    ActionMcp.layerHttp(caller, { name: "public", version: "0", path: "/mcp/caller" }),
  );

  it("wins over a caller provided around Testing.layer, which reaches only the other routes", async () => {
    // One caller for the routes no authentication covers, and tokens for the rest.
    const harness = Testing.layer(Layer.mergeAll(host, native, uncovered)).pipe(
      Layer.provide(Layer.succeed(CurrentActor, actors.reader)),
    );

    const answered = await Effect.gen(function* () {
      const http = yield* ActionHttp.client(Http, as("alice"));
      const mcp = yield* Testing.mcpClient([WhoAmI, RenameUser], as("alice"));

      const nativeId = yield* HttpClient.execute(
        HttpClientRequest.post("/native/whoAmI").pipe(HttpClientRequest.bearerToken("alice")),
      ).pipe(Effect.flatMap((response) => response.text));

      const identities = {
        http: (yield* http.whoAmI()).id,
        mcp: (yield* mcp.whoAmI()).id,
        native: nativeId,
      };

      // The hook reads the identity too: alice may write, where the caller may only read.
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
    }).pipe(Effect.provide(harness), Effect.runPromise);

    expect(answered).toEqual({
      identities: { http: "alice", mcp: "alice", native: "alice" },
      renamed: [
        { id: "1", name: "Bea" },
        { id: "1", name: "Cy" },
      ],
      anonymous: { http: "reader", mcp: "reader" },
    });
  });

  it("wins over an identity provided at a server's startup, so a caller reads its own tenant", async () => {
    // The documented mistake: an identity at the root of the server, as for a background job.
    const server = HttpRouter.serve(host, { disableLogger: true, disableListenLog: true }).pipe(
      Layer.provide(Layer.succeed(CurrentActor, actors.bob)),
      Layer.provideMerge(NodeHttpServer.layerTest),
    );

    const users = await Effect.gen(function* () {
      const http = yield* ActionHttp.client(Http, as("alice"));
      const mcp = yield* Testing.mcpClient([GetUser], as("alice"));

      return [yield* http.getUser({ id: "1" }), yield* mcp.getUser({ id: "1" })];
    }).pipe(Effect.provide(server), Effect.runPromise);

    // Alice's tenant's user, never the one of bob's tenant.
    expect(users).toEqual([
      { id: "1", name: "Ada" },
      { id: "1", name: "Ada" },
    ]);
  });
});

describe("a value provided per request", () => {
  class Tenant extends Context.Service<Tenant, string>()("request-context/Tenant") {}

  const Where = Action.make("where", {
    description: "Name the request's tenant.",
    access: "read",
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

      const Who = Action.make("who", { description: "Record the caller.", access: "read" });

      const who = Action.implement(
        Who,
        () => Effect.flatMap(Actor, (actor) => Effect.sync(() => seen.push(`handler: ${actor}`))),
        () => Effect.flatMap(Actor, (actor) => Effect.sync(() => void seen.push(`hook: ${actor}`))),
      );

      const tools = ActionToolkit.make(who);

      const Chat = Action.make("chat", {
        description: "Call a tool as a narrower delegate of the caller.",
        access: "read",
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
      expect(seen).toEqual(["hook: delegate of alice", "handler: delegate of alice"]);
    },
  );
});

describe("what the routes were built with", () => {
  const Level = Action.make("level", {
    description: "Name the current log level.",
    access: "read",
    success: Schema.String,
  });

  const Boom = Action.make("boom", { description: "Die.", access: "write" });

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

  it.each(["HTTP", "MCP"] as const)(
    "yields to what the server runs in, unless HttpRouter.provideRequest gives it to its requests, over %s",
    async (transport) => {
      const Stage = Context.Reference<string>("request-context/Stage", {
        defaultValue: () => "default",
      });

      const Probe = Action.make("probe", {
        description: "Name the stage and the log level.",
        access: "read",
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

      const answers = await Effect.runPromise(
        Effect.all([probeAt("/built"), probeAt("/scoped")]).pipe(
          Effect.provide(Testing.layer(routes)),
          // What the server runs in, as values provided around `HttpRouter.serve` are.
          Effect.provideService(Stage, "server"),
          Effect.provideService(References.CurrentLogLevel, "Warn"),
        ),
      );

      expect(answers).toEqual([
        { stage: "server", level: "Warn" },
        { stage: "scoped", level: "Debug" },
      ]);
    },
  );

  it.each(["HTTP", "MCP"] as const)(
    "never holds what a call acquires: its request releases it, over %s",
    async (transport) => {
      const events: Array<string> = [];

      const Hold = Action.make("hold", { description: "Hold a resource.", access: "write" });

      const hold = Action.implement(Hold, () =>
        Effect.acquireRelease(
          Effect.sync(() => void events.push("acquire")),
          () => Effect.sync(() => void events.push("release")),
        ),
      );

      const routes =
        transport === "HTTP"
          ? ActionHttp.layer(ActionHttp.make([Hold]), hold)
          : ActionMcp.layerHttp(hold, { name: "test", version: "0" });

      const web = serve(routes);

      const call = () =>
        web.handler(transport === "HTTP" ? post("/api/hold") : rawToolCall("hold"));

      await call();
      await call();

      expect(events).toEqual(["acquire", "release", "acquire", "release"]);
    },
  );

  it.each(["HTTP", "MCP"] as const)(
    "reports a handler's defect to their error reporters, once, over %s",
    async (transport) => {
      const reported: Array<string> = [];
      const reporter = ErrorReporter.make(({ error }) => void reported.push(error.message));

      const boom = Action.implement(Boom, () => Effect.die(new Error("boom")));

      const routes =
        transport === "HTTP"
          ? ActionHttp.layer(ActionHttp.make([Boom]), boom)
          : ActionMcp.layerHttp(boom, { name: "test", version: "0" });

      const web = serve(routes.pipe(Layer.provide(ErrorReporter.layer([reporter]))));

      await web.handler(transport === "HTTP" ? post("/api/boom") : rawToolCall("boom"));

      expect(reported).toEqual(["boom"]);
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

      if (transport === "HTTP") {
        await web.handler(post("/api/level"), context);
      } else {
        await withMcpClient({ fetch: (request) => web.handler(request, context) }, (client) =>
          client.callTool({ name: "level", arguments: {} }),
        );
      }

      expect(parents.get("level")).toMatch(
        transport === "HTTP" ? /^http\.server POST$/ : /^McpServer\..*tools\/call$/,
      );
    },
  );
});

describe("over stdio", () => {
  it("gives a tool call the identity the host provides around runStdio", async () => {
    class Actor extends Context.Service<Actor, string>()("request-context/StdioActor") {}

    const Who = Action.make("who", {
      description: "Name the caller.",
      access: "read",
      success: Schema.String,
    });

    const hooked: Array<string> = [];

    const who = Action.implement(
      Who,
      () => Actor,
      () => Effect.flatMap(Actor, (actor) => Effect.sync(() => void hooked.push(actor))),
    );

    const { body } = statelessRequest("tools/call", { name: "who", arguments: {} });
    const written: Array<string> = [];
    const decoder = new TextDecoder();

    await Effect.gen(function* () {
      const answered = yield* Deferred.make<void>();

      // The host keeps stdin open until the answer is written, then closes it: the server ends.
      const stdin = Stream.concat(
        Stream.encodeText(Stream.make(`${JSON.stringify(body)}\n`)),
        Stream.fromEffectDrain(Deferred.await(answered)),
      );

      const stdout = () =>
        Sink.forEach((chunk: string | Uint8Array) =>
          Effect.andThen(
            Effect.sync(() =>
              written.push(chunk instanceof Uint8Array ? decoder.decode(chunk) : chunk),
            ),
            Deferred.succeed(answered, undefined),
          ),
        );

      yield* ActionMcp.runStdio(who, { name: "test", version: "0" }).pipe(
        Effect.provideService(Actor, "host"),
        Effect.provide(Stdio.layerTest({ stdin, stdout })),
      );
    }).pipe(Effect.runPromise);

    expect(JSON.parse(written.join(""))).toMatchObject({
      result: { structuredContent: "host" },
    });
    expect(hooked).toEqual(["host"]);
  });
});
