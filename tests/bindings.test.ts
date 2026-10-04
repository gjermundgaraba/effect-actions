import { describe, expect, it } from "@effect/vitest";
import { Context, Effect, Layer, Logger, Option, References, Schema, Stream, Tracer } from "effect";
import { NodeHttpServer } from "@effect/platform-node";
import { HttpRouter, HttpServerResponse } from "effect/http";
import { HttpApi, HttpApiClient, HttpApiSecurity, OpenApi } from "effect/http-api";
import * as Action from "../src/Action.js";
import * as ActionHttp from "../src/ActionHttp.js";
import * as ActionMcp from "../src/ActionMcp.js";
import * as ActionToolkit from "../src/ActionToolkit.js";
import * as Testing from "../src/Testing.js";
import { withMcpClient } from "./mcp-client.js";
import { post, rawToolCall, send } from "./requests.js";
import { serve, serveWithContext } from "./serve.js";

class Actor extends Context.Service<Actor, string>()("bindings/Actor") {}

const identity = Action.make("identity", {
  description: "Request identity",
  access: "write",
  success: Schema.String,
});

// Build capabilities and request identities have distinct tags.
class Greeting extends Context.Service<Greeting, string>()("bindings/Greeting") {}

it("builds an implementation once per layer graph, however many surfaces serve it", async () => {
  let acquired = 0;
  let finalized = 0;

  const app = Action.implement(
    identity,
    Effect.gen(function* () {
      const greeting = yield* Effect.acquireRelease(
        Effect.gen(function* () {
          yield* Effect.sync(() => acquired++);

          return yield* Greeting;
        }),
        () => Effect.sync(() => finalized++),
      );

      return () => Effect.map(Actor, (actor) => `${greeting}/${actor}`);
    }),
    Action.allowAll,
  );

  const routes = Layer.mergeAll(
    ActionHttp.layer(ActionHttp.make([identity]), app),
    ActionHttp.layer(ActionHttp.make([identity], { prefix: "/v2" }), app),
    ActionMcp.layerHttp(app, {
      name: "test",
      version: "0",
    }),
  ).pipe(Layer.provide(Layer.succeed(Greeting, "build")));

  // Three layers serve the implementation and share one build per runtime. Reusing the
  // implementation across runtimes must not share state.
  for (let runtime = 1; runtime <= 2; runtime++) {
    const web = serveWithContext(routes);

    try {
      const response = await web.handler(post("/api/identity"), Context.make(Actor, "http"));

      expect(await response.json()).toBe("build/http");
      expect(
        await (await web.handler(post("/v2/identity"), Context.make(Actor, "v2"))).json(),
      ).toBe("build/v2");
      await withMcpClient(
        {
          fetch: (request) => web.handler(request, Context.make(Actor, "mcp")),
        },
        async (client) => {
          expect(
            (await client.callTool({ name: "identity", arguments: {} })).structuredContent,
          ).toBe("build/mcp");
        },
      );
      expect(acquired).toBe(runtime);
      expect(finalized).toBe(runtime - 1);
    } finally {
      await web.dispose();
    }

    expect(finalized).toBe(runtime);
  }
});

it("releases what an HTTP call acquires when the call ends, before route middleware resumes", async () => {
  const log: string[] = [];

  const Open = Action.make("open", {
    description: "Opens a resource of its own",
    access: "write",
    success: Schema.String,
  });

  const logged = (name: string) =>
    Effect.acquireRelease(
      Effect.sync(() => log.push(`${name} acquire`)),
      () => Effect.sync(() => log.push(`${name} release`)),
    );

  const app = Action.implement(
    Open,
    () => Effect.as(logged("handler"), "opened"),
    () => Effect.asVoid(logged("hook")),
  );

  const around = HttpRouter.middleware((route) =>
    Effect.gen(function* () {
      log.push("middleware before");
      const response = yield* route;
      log.push("middleware after");

      return response;
    }),
  ).layer;

  const web = serve(ActionHttp.layer(ActionHttp.make([Open]), app).pipe(Layer.provide(around)));

  expect(await (await web.handler(post("/api/open"))).json()).toBe("opened");
  expect(log).toEqual([
    "middleware before",
    "hook acquire",
    "handler acquire",
    "handler release",
    "hook release",
    "middleware after",
  ]);
});

describe("sharing an implementation's builder", () => {
  const secret = Action.make("secret", {
    description: "Only for the trusted",
    access: "read",
    success: Schema.String,
  });

  const Http = ActionHttp.make([identity, secret]);

  /** An implementation of both actions whose builder counts its runs, behind `before`. */
  const counted = <RB = never, EB = never, RBX = never>(
    before:
      | Action.Before<typeof identity | typeof secret, RB>
      | Effect.Effect<Action.Before<typeof identity | typeof secret, RB>, EB, RBX>,
  ) => {
    const runs = { built: 0 };

    const app = Action.implement(
      [identity, secret],
      Effect.sync(() => {
        runs.built++;

        return { identity: () => Effect.succeed("shared"), secret: () => Effect.succeed("hidden") };
      }),
      before,
    );

    return { runs, app };
  };

  /** A tool call on `path`, as the value it returned or the tag it failed with. */
  const call = (path: string, name: "identity" | "secret") =>
    Effect.flatMap(Testing.mcpClient([identity, secret], { url: path }), (mcp) =>
      mcp[name]().pipe(Effect.catchTag("Forbidden", ({ _tag }) => Effect.succeed(_tag))),
    );

  it.effect(
    "runs the builder once for an implementation and its shares, with and without another hook, on every surface",
    () =>
      Effect.gen(function* () {
        const { runs, app } = counted(() => Effect.fail(new Action.Forbidden()));
        const kept = Action.share([identity], app);
        const open = Action.share([identity], app, Action.allowAll);

        const routes = Layer.mergeAll(
          ActionHttp.layer(Http, app),
          ActionHttp.layer(ActionHttp.make([identity], { prefix: "/kept" }), kept),
          ActionHttp.layer(ActionHttp.make([identity], { prefix: "/open" }), open),
          ActionMcp.layerHttp(kept, { name: "kept", version: "0", path: "/mcp/kept" }),
          ActionMcp.layerHttp(open, { name: "open", version: "0", path: "/mcp/open" }),
          ActionToolkit.make([kept, Action.share([secret], app, Action.allowAll)]).layer,
        );

        yield* Effect.gen(function* () {
          expect((yield* send(post("/kept/identity"))).status).toBe(403);
          expect(yield* (yield* send(post("/open/identity"))).json).toBe("shared");
          expect(yield* call("/mcp/kept", "identity")).toBe("Forbidden");
          expect(yield* call("/mcp/open", "identity")).toBe("shared");
        }).pipe(Effect.provide(Testing.layer(routes)));

        // Five implementations on three surfaces, one builder run.
        expect(runs.built).toBe(1);
      }),
  );

  it("holds only the actions it is given, and refuses one its source does not implement", () => {
    const { app } = counted(() => Effect.void);
    const open = Action.share([identity], app, Action.allowAll);

    expect(open.actions).toEqual([identity]);

    // An action the source does not implement is refused when `share` is called.
    const stranger = Action.make("stranger", { description: "", access: "read" });

    expect(() => Action.share([stranger], open)).toThrow(
      "Not implemented by this implementation: stranger",
    );
  });

  it.effect("runs each hook for its own actions, without building the shared handlers again", () =>
    Effect.gen(function* () {
      const hooks: Array<string> = [];

      const { runs, app } = counted((action) =>
        Effect.sync(() => {
          hooks.push(`source ${action.name}`);
        }),
      );

      const admin = Action.share([secret], app, (action) =>
        Effect.sync(() => {
          hooks.push(`admin ${action.name}`);
        }),
      );

      const routes = Layer.mergeAll(
        ActionHttp.layer(Http, app),
        ActionHttp.layer(ActionHttp.make([secret], { prefix: "/admin" }), admin),
        ActionMcp.layerHttp(admin, { name: "admin", version: "0" }),
      );

      yield* Effect.gen(function* () {
        expect(yield* (yield* send(post("/api/identity"))).json).toBe("shared");
        expect(yield* (yield* send(post("/api/secret"))).json).toBe("hidden");
        expect(yield* (yield* send(post("/admin/secret"))).json).toBe("hidden");
        expect(yield* call("/mcp", "secret")).toBe("hidden");
      }).pipe(Effect.provide(Testing.layer(routes)));

      expect(hooks).toEqual(["source identity", "source secret", "admin secret", "admin secret"]);
      expect(runs.built).toBe(1);
    }),
  );

  it.effect(
    "builds a share's own built hook once, and never runs its source's builder again for it",
    () =>
      Effect.gen(function* () {
        const builds = { sourceHook: 0, openHook: 0 };

        const { runs, app } = counted(
          Effect.sync(() => {
            builds.sourceHook++;

            return () => Effect.fail(new Action.Forbidden());
          }),
        );

        const open = Action.share(
          [identity],
          app,
          Effect.sync(() => {
            builds.openHook++;

            return Action.allowAll;
          }),
        );

        const both = Layer.mergeAll(
          ActionHttp.layer(Http, app),
          // A share given no hook keeps its source's, built once for both.
          ActionHttp.layer(
            ActionHttp.make([identity], { prefix: "/kept" }),
            Action.share([identity], app),
          ),
          ActionHttp.layer(ActionHttp.make([identity], { prefix: "/open" }), open),
          ActionMcp.layerHttp(open, { name: "open", version: "0" }),
        );

        yield* Effect.gen(function* () {
          expect((yield* send(post("/api/identity"))).status).toBe(403);
          expect((yield* send(post("/kept/identity"))).status).toBe(403);
          expect(yield* (yield* send(post("/open/identity"))).json).toBe("shared");
          expect(yield* call("/mcp", "identity")).toBe("shared");
        }).pipe(Effect.provide(Testing.layer(both)));

        expect({ ...runs, ...builds }).toEqual({ built: 1, sourceHook: 1, openHook: 1 });

        // Served alone, a share with a hook of its own builds its source's handlers, not its hook.
        const alone = ActionHttp.layer(ActionHttp.make([identity]), open);

        yield* Effect.gen(function* () {
          expect(yield* (yield* send(post("/api/identity"))).json).toBe("shared");
        }).pipe(Effect.provide(Testing.layer(alone)));

        expect({ ...runs, ...builds }).toEqual({ built: 2, sourceHook: 1, openHook: 2 });
      }),
  );
});

it("builds a shared implementation with one set of startup services, not one per surface", async () => {
  const app = Action.implement(
    identity,
    Effect.map(Greeting, (greeting) => () => Effect.succeed(greeting)),
    Action.allowAll,
  );

  // Startup services provided around one surface reach every surface serving the same
  // implementation: its builder runs once, with the services of whichever builds it.
  const web = serve(
    Layer.mergeAll(
      ActionHttp.layer(ActionHttp.make([identity]), app).pipe(
        Layer.provide(Layer.succeed(Greeting, "http")),
      ),
      ActionMcp.layerHttp(app, { name: "test", version: "0" }).pipe(
        Layer.provide(Layer.succeed(Greeting, "mcp")),
      ),
    ),
  );

  const http = await (await web.handler(post("/api/identity"))).json();

  await withMcpClient({ fetch: web.handler }, async (client) => {
    expect((await client.callTool({ name: "identity", arguments: {} })).structuredContent).toBe(
      http,
    );
  });
});

it.effect("builds once beside routes served apart, when Action.layer is provided above both", () =>
  Effect.gen(function* () {
    const Count = Action.make("count", { description: "", access: "read", success: Schema.Finite });

    class Start extends Context.Service<Start, number>()("bindings/Start") {}

    for (const order of ["routes first", "toolkit first"] as const) {
      let built = 0;
      let hooked = 0;

      // Its startup service is given once, above `Action.layer` and every surface, to its
      // handlers' builder and its hook's.
      const app = Action.implement(
        Count,
        Effect.map(Start, (start) => {
          built += 1;

          return () => Effect.succeed(start + built);
        }),
        Effect.map(Start, () => {
          hooked += 1;

          return Action.allowAll;
        }),
      );

      // Testing.layer, like HttpRouter.serve, builds its routes apart from the other layers.
      const routes = Testing.layer(ActionHttp.layer(ActionHttp.make([Count]), app));
      const tools = ActionToolkit.make(app);

      const layers = (
        order === "routes first"
          ? Layer.mergeAll(routes, tools.layer)
          : Layer.mergeAll(tools.layer, routes)
      ).pipe(Layer.provide(Action.layer(app)), Layer.provide(Layer.succeed(Start, 0)));

      yield* Effect.gen(function* () {
        const client = yield* ActionHttp.client(ActionHttp.make([Count]));
        const toolkit = yield* tools.toolkit;

        yield* client.count();
        yield* Stream.runCollect(yield* toolkit.handle("count", {}));
      }).pipe(Effect.provide(layers));

      expect([order, built, hooked]).toEqual([order, 1, 1]);
    }
  }),
);

describe("a builder beside HttpRouter.serve", () => {
  const Count = Action.make("count", { description: "", access: "read", success: Schema.Finite });

  const Http = ActionHttp.make([Count]);

  /** An implementation counting its calls in the state its builder makes, and its builds. */
  const counted = () => {
    const builds = { count: 0 };

    const app = Action.implement(
      Count,
      Effect.sync(() => {
        builds.count += 1;
        let calls = 0;

        return () => Effect.sync(() => ++calls);
      }),
      Action.allowAll,
    );

    return { app, builds };
  };

  it.effect.each(["routes first", "job first"] as const)(
    "builds once for a job inside the served layer, which shares the routes' state (%s)",
    (order) =>
      Effect.gen(function* () {
        const { app, builds } = counted();
        const tools = ActionToolkit.make(app);

        // A job the process runs beside its routes: it calls the implementation once, as a tool.
        const job = Layer.effectDiscard(
          Effect.flatMap(tools.toolkit, (toolkit) =>
            Effect.flatMap(toolkit.handle("count", {}), Stream.runDrain),
          ),
        ).pipe(Layer.provide(tools.layer));

        const routes = ActionHttp.layer(Http, app);

        const server = HttpRouter.serve(
          order === "routes first" ? Layer.mergeAll(routes, job) : Layer.mergeAll(job, routes),
          { disableLogger: true, disableListenLog: true },
        ).pipe(Layer.provideMerge(NodeHttpServer.layerTest));

        const count = yield* Effect.flatMap(ActionHttp.client(Http), (client) =>
          client.count(),
        ).pipe(Effect.provide(server));

        // The route counts the job's call: one build, one state.
        expect([builds.count, count]).toEqual([1, 2]);
      }),
  );

  it.effect.each(["HTTP first", "MCP first"] as const)(
    "builds once per surface under Layer.fresh, each with its own startup services (%s)",
    (order) =>
      Effect.gen(function* () {
        const builds = { count: 0 };

        const Greet = Action.make("greet", {
          description: "",
          access: "read",
          success: Schema.String,
        });

        const app = Action.implement(
          Greet,
          Effect.map(Greeting, (greeting) => {
            builds.count += 1;

            return () => Effect.succeed(greeting);
          }),
          Action.allowAll,
        );

        const http = Layer.fresh(
          ActionHttp.layer(ActionHttp.make([Greet]), app).pipe(
            Layer.provide(Layer.succeed(Greeting, "http")),
          ),
        );

        const mcp = Layer.fresh(
          ActionMcp.layerHttp(app, { name: "test", version: "0" }).pipe(
            Layer.provide(Layer.succeed(Greeting, "mcp")),
          ),
        );

        const greetings = yield* Effect.gen(function* () {
          const client = yield* ActionHttp.client(ActionHttp.make([Greet]));
          const tools = yield* Testing.mcpClient([Greet]);

          return [yield* client.greet(), yield* tools.greet()];
        }).pipe(
          Effect.provide(
            Testing.layer(
              order === "HTTP first" ? Layer.mergeAll(http, mcp) : Layer.mergeAll(mcp, http),
            ),
          ),
        );

        expect([builds.count, greetings]).toEqual([2, ["http", "mcp"]]);
      }),
  );

  it.effect.each(["route first", "MCP first"] as const)(
    "builds a Toolkit's handlers once for a route whose builder yields its toolkit, beside another surface (%s)",
    (order) =>
      Effect.gen(function* () {
        const { app, builds } = counted();
        const tools = ActionToolkit.make(app);

        // A model loop in a route: its builder yields the toolkit, and the route's layer takes
        // the toolkit's handler layer, built in the routes' layer graph, as the endpoint's is.
        const Chat = Action.make("chat", {
          description: "",
          access: "read",
          success: Schema.Finite,
        });

        const chat = Action.implement(
          Chat,
          Effect.map(
            tools.toolkit,
            (toolkit) => () =>
              Effect.gen(function* () {
                const [called] = yield* Stream.runCollect(yield* toolkit.handle("count", {}));

                return Number(called?.result);
              }).pipe(Effect.orDie),
          ),
          Action.allowAll,
        );

        const ChatHttp = ActionHttp.make([Chat]);
        const route = ActionHttp.layer(ChatHttp, chat).pipe(Layer.provide(tools.layer));
        const mcp = ActionMcp.layerHttp(app, { name: "test", version: "0" });

        const counts = yield* Effect.gen(function* () {
          const client = yield* ActionHttp.client(ChatHttp);
          const endpoint = yield* Testing.mcpClient([Count]);

          return [yield* client.chat(), yield* endpoint.count(), yield* client.chat()];
        }).pipe(
          Effect.provide(
            Testing.layer(
              order === "route first" ? Layer.mergeAll(route, mcp) : Layer.mergeAll(mcp, route),
            ),
          ),
        );

        // The route's tool calls and the endpoint's call count in one state: one build.
        expect([builds.count, counts]).toEqual([1, [1, 2, 3]]);
      }),
  );
});

it("serves a copy of a binding like the binding itself", async () => {
  const Http = ActionHttp.make([identity], { prefix: "/v1" });
  const app = Action.implement(identity, () => Effect.succeed("copied"), Action.allowAll);

  const web = serve(ActionHttp.layer({ ...Http }, app));

  expect(await (await web.handler(post("/v1/identity"))).json()).toBe("copied");
});

it("serves a binding with no actions beside one with routes", async () => {
  const app = Action.implement(identity, () => Effect.succeed("served"), Action.allowAll);

  const web = serve(
    Layer.mergeAll(
      ActionHttp.layer(ActionHttp.make([], { prefix: "/empty" }), []),
      ActionHttp.layer(ActionHttp.make([identity], { prefix: "/v1" }), app),
    ),
  );

  expect(await (await web.handler(post("/v1/identity"))).json()).toBe("served");
  expect((await web.handler(post("/empty/identity"))).status).toBe(404);
});

it("refuses an object that only looks like an implementation", () => {
  // SAFETY: deliberately fabricated, as a second installed copy of the package would make one.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Fabrication fixture.
  const fake = { actions: [identity] } as never;

  expect(() => ActionHttp.layer(ActionHttp.make([identity]), fake)).toThrow(
    "Not an implementation made by this Action.implement",
  );
});

it("keeps same-contract implementations apart over MCP", async () => {
  const a = Action.implement(identity, () => Effect.succeed("a"), Action.allowAll);
  const b = Action.implement(identity, () => Effect.succeed("b"), Action.allowAll);

  const web = serve(
    Layer.mergeAll(
      ActionMcp.layerHttp(a, {
        name: "a",
        version: "0",
        path: "/a",
      }),
      ActionMcp.layerHttp(b, {
        name: "b",
        version: "0",
        path: "/b",
      }),
    ),
  );

  for (const name of ["a", "b", "a"]) {
    await withMcpClient({ fetch: web.handler, path: `/${name}` }, async (client) => {
      expect((await client.callTool({ name: "identity", arguments: {} })).structuredContent).toBe(
        name,
      );
    });
  }
});

it("records a tool call's arguments on its span, a Schema.Redacted value included, where HTTP records no body", async () => {
  const Login = Action.make("login", {
    description: "",
    access: "write",
    input: { password: Schema.Redacted(Schema.String) },
    success: Schema.String,
  });

  const app = Action.implement(Login, () => Effect.succeed("in"), Action.allowAll);

  // What every span of a call carries: each attribute, as the tracer receives it.
  const recorded = async <A>(call: (tracer: Tracer.Tracer) => Promise<A>) => {
    const spans: Tracer.Span[] = [];

    await call(
      Tracer.make({
        span(options) {
          const span = Tracer.nativeTracer.span(options);
          spans.push(span);

          return span;
        },
      }),
    );

    return spans.flatMap((span) => [...span.attributes.values()]);
  };

  const web = serveWithContext(
    Layer.mergeAll(
      ActionHttp.layer(ActionHttp.make([Login]), app),
      ActionMcp.layerHttp(app, { name: "test", version: "0" }),
    ),
  );

  const tools = ActionToolkit.make(app);
  const sent = { password: "hunter2" };

  const http = await recorded((tracer) =>
    web.handler(post("/api/login", sent), Context.make(Tracer.Tracer, tracer)),
  );

  const mcp = await recorded((tracer) =>
    web.handler(rawToolCall("login", sent), Context.make(Tracer.Tracer, tracer)),
  );

  const toolkit = await recorded((tracer) =>
    Effect.flatMap(tools.toolkit, (handled) =>
      Effect.flatMap(handled.handle("login", sent), Stream.runDrain),
    ).pipe(
      Effect.withSpan("caller"),
      Effect.provide(tools.layer),
      Effect.provideService(Tracer.Tracer, tracer),
      Effect.runPromise,
    ),
  );

  // The action's span is recorded on every surface; only a tool call's carries the input.
  expect(http).toContain("login");
  expect(http).not.toContainEqual(sent);
  expect(mcp).toContainEqual(sent);
  expect(toolkit).toContainEqual(sent);
});

describe.each(["HTTP", "MCP"] as const)("request logging and tracing: %s", (transport) => {
  // The MCP span name carries the protocol revision.
  const requestSpan = transport === "HTTP" ? /^http\.server POST$/ : /^McpServer\..*tools\/call$/;

  const run = async (
    handler: () => Effect.Effect<string>,
    before: Action.Before<typeof identity> = Action.allowAll,
  ) => {
    const logs: unknown[] = [];
    const annotations: Array<ReadonlyMap<string, unknown>> = [];
    const parents = new Map<string, string | undefined>();
    const spans = new Map<string, Tracer.Span>();

    const logger = Logger.make((options) => {
      logs.push(options.message);
      annotations.push(
        new Map(Object.entries(options.fiber.getRef(References.CurrentLogAnnotations))),
      );
    });

    const tracer = Tracer.make({
      span(options) {
        const parent = Option.getOrUndefined(options.parent);

        parents.set(options.name, parent?._tag === "Span" ? parent.name : undefined);
        const span = Tracer.nativeTracer.span(options);
        spans.set(options.name, span);

        return span;
      },
    });

    const app = Action.implement(identity, handler, before);

    const routes =
      transport === "HTTP"
        ? ActionHttp.layer(ActionHttp.make([identity]), app)
        : ActionMcp.layerHttp(app, {
            name: "test",
            version: "0",
          });

    // Each request carries its own logger and tracer context.
    const web = serveWithContext(routes);

    const context = Context.make(Logger.CurrentLoggers, new Set([logger])).pipe(
      Context.add(Tracer.Tracer, tracer),
    );

    if (transport === "HTTP") {
      await web.handler(post("/api/identity"), context);
    } else {
      await withMcpClient(
        {
          fetch: (request) => web.handler(request, context),
        },
        (client) => client.callTool({ name: "identity", arguments: {} }).catch(() => undefined),
      );
    }

    return { logs, annotations, parents, spans };
  };

  it("runs the handler in an action span under the request span", async () => {
    const { logs, annotations, parents, spans } = await run(() =>
      Effect.log("handler ran").pipe(Effect.as("ok"), Effect.withSpan("action.identity")),
    );

    expect(logs).toContainEqual(["handler ran"]);
    // The action span is named by the action on both transports.
    expect(parents.get("action.identity")).toBe("identity");
    expect(parents.get("identity")).toMatch(requestSpan);

    // The contract's identity is on the span and on every handler log line.
    const identity = new Map([
      ["action.name", "identity"],
      ["action.access", "write"],
    ]);

    expect(spans.get("identity")?.attributes).toEqual(identity);
    expect(annotations).toContainEqual(identity);
  });

  it("runs the hook outside the action span, under the request span", async () => {
    const { parents } = await run(
      () => Effect.succeed("ok"),
      () => Effect.withSpan(Effect.void, "hook"),
    );

    expect(parents.get("hook")).toMatch(requestSpan);
    expect(parents.get("identity")).toMatch(requestSpan);
  });

  it("opens the action span even when the handler throws before returning an effect", async () => {
    const { parents } = await run(() => {
      throw new Error("boom");
    });

    expect(parents.get("identity")).toMatch(requestSpan);
  });
});

it.each(["HTTP", "MCP"])(
  "provides request identity through router wiring over %s",
  async (transport) => {
    const app = Action.implement(identity, () => Actor, Action.allowAll);

    const routes =
      transport === "HTTP"
        ? ActionHttp.layer(ActionHttp.make([identity]), app)
        : ActionMcp.layerHttp(app, {
            name: "test",
            version: "0",
          });

    const web = serve(routes.pipe(HttpRouter.provideRequest(Layer.succeed(Actor, "request"))));

    const response = await web.handler(
      transport === "HTTP" ? post("/api/identity") : rawToolCall("identity"),
    );

    expect(response.status).toBe(200);

    if (transport === "HTTP") {
      expect(await response.json()).toBe("request");
    } else {
      expect(await response.json()).toMatchObject({
        result: { structuredContent: "request" },
      });
    }
  },
);

class Tenant extends Context.Service<Tenant, string>()("bindings/Tenant") {}

const WhoAmI = Action.make("whoAmI", {
  description: "Current user",
  access: "write",
  success: Schema.String,
});

const Invoice = Action.make("invoice", {
  description: "Invoice total",
  access: "write",
  input: { amount: Schema.FiniteFromString },
  success: Schema.Finite,
});

const Audit = Action.make("audit", {
  description: "Audit",
  access: "write",
  success: Schema.String,
});

const whoAmI = Action.implement(
  WhoAmI,
  Effect.map(Tenant, (tenant) => () => Effect.succeed(`ada@${tenant}`)),
  Action.allowAll,
);

const billing = Action.implement(
  [Invoice, Audit],
  {
    invoice: ({ amount }) => Effect.succeed(amount * 2),
    audit: () => Effect.succeed("clean"),
  },
  Action.allowAll,
);

const Http = ActionHttp.make([WhoAmI, Invoice, Audit]);

describe("HTTP bindings", () => {
  it.each([
    { prefix: undefined, mounted: "/api", route: "/api/whoAmI" },
    { prefix: "/", mounted: "/", route: "/whoAmI" },
    { prefix: "/v1/", mounted: "/v1", route: "/v1/whoAmI" },
    { prefix: "/v1/internal", mounted: "/v1/internal", route: "/v1/internal/whoAmI" },
  ] as const)("mounts routes and the document under prefix $prefix", async (mount) => {
    const binding = ActionHttp.make(
      [WhoAmI],
      mount.prefix === undefined ? {} : { prefix: mount.prefix },
    );

    const handler = serve(
      ActionHttp.layer(binding, whoAmI).pipe(Layer.provide(Layer.succeed(Tenant, "acme"))),
    ).handler;

    expect(binding.prefix).toBe(mount.mounted);
    expect(await (await handler(post(mount.route))).json()).toBe("ada@acme");
    expect(Object.keys(OpenApi.fromApi(binding.api).paths)).toEqual([mount.route]);
  });

  it.each([
    ["/api", "/api/whoAmI", "api"],
    ["/v2/api", "/v2/api/whoAmI", "v2/api"],
    ["/", "/whoAmI", "/"],
  ] as const)("tags the group under prefix %s with its mount path", (prefix, route, tag) => {
    const document = OpenApi.fromApi(ActionHttp.make([WhoAmI, Invoice, Audit], { prefix }).api);

    expect(document.tags.map(({ name }) => name)).toEqual([tag]);
    expect(document.paths[route]?.post?.tags).toEqual([tag]);
  });

  it("preserves action APIs composed into a native host API", () => {
    const combined = HttpApi.make("host")
      .addHttpApi(ActionHttp.make([WhoAmI], { prefix: "/public" }).api)
      .addHttpApi(ActionHttp.make([Invoice, Audit], { prefix: "/admin" }).api);

    expect(Object.keys(OpenApi.fromApi(combined).paths)).toEqual([
      "/public/whoAmI",
      "/admin/invoice",
      "/admin/audit",
    ]);

    // The root's group is not the `/actions` binding's, although both would read `actions`.
    const rooted = HttpApi.make("host")
      .addHttpApi(ActionHttp.make([WhoAmI], { prefix: "/" }).api)
      .addHttpApi(ActionHttp.make([Invoice], { prefix: "/actions" }).api);

    expect(Object.keys(OpenApi.fromApi(rooted).paths)).toEqual(["/whoAmI", "/actions/invoice"]);
  });

  const Alpha = Action.make("alpha", {
    description: "Alpha",
    access: "write",
    success: Schema.String,
  });

  const Beta = Action.make("beta", {
    description: "Beta",
    access: "write",
    success: Schema.String,
  });

  it("refuses an implementation holding none of its binding's actions, and serves each once", () => {
    const bound = ActionHttp.make([Alpha]);

    const LookAlike = Action.make("alpha", {
      description: "Alpha",
      access: "write",
      success: Schema.String,
    });

    const alpha = Action.implement(Alpha, () => Effect.succeed("x"), Action.allowAll);

    // Pairing is by identity: the same name and schemas do not make it this action.
    expect(() =>
      ActionHttp.layer(
        bound,
        Action.implement(LookAlike, () => Effect.succeed("x"), Action.allowAll),
      ),
    ).toThrow("No action of this implementation is in this HTTP binding: alpha (another contract)");
    expect(() =>
      ActionHttp.layer(
        bound,
        Action.implement(Beta, () => Effect.succeed("x"), Action.allowAll),
      ),
    ).toThrow("No action of this implementation is in this HTTP binding: beta");
    expect(() => ActionHttp.layer(bound, [alpha, alpha])).toThrow("Duplicate served action: alpha");
    expect(() =>
      ActionHttp.layer(bound, [
        alpha,
        Action.implement(Alpha, () => Effect.succeed("y"), Action.allowAll),
      ]),
    ).toThrow("Duplicate served action: alpha");

    const text = () => Effect.succeed("x");

    // Only the names it serves are checked: both implementations hold a `beta` it leaves out.
    expect(() =>
      ActionHttp.layer(ActionHttp.make([Alpha, Audit]), [
        Action.implement([Alpha, Beta], { alpha: text, beta: text }, Action.allowAll),
        Action.implement([Audit, Beta], { audit: text, beta: text }, Action.allowAll),
      ]),
    ).not.toThrow();
  });

  it("serves the actions its binding holds among an implementation's, and no others", async () => {
    let built = 0;
    const hooked: Array<string> = [];

    // One builder for an action HTTP serves and one it leaves to other surfaces.
    const app = Action.implement(
      [Alpha, Beta],
      Effect.sync(() => {
        built++;

        return { alpha: () => Effect.succeed("alpha"), beta: () => Effect.succeed("beta") };
      }),
      (action) =>
        Effect.sync(() => {
          hooked.push(action.name);
        }),
    );

    const web = serve(
      Layer.mergeAll(
        ActionHttp.layer(ActionHttp.make([Alpha]), app),
        ActionMcp.layerHttp(app, { name: "test", version: "0" }),
      ),
    );

    expect(await (await web.handler(post("/api/alpha"))).json()).toBe("alpha");
    expect((await web.handler(post("/api/beta"))).status).toBe(404);

    const tool = await web.handler(rawToolCall("beta"));

    expect(await tool.json()).toMatchObject({ result: { structuredContent: "beta" } });
    expect({ built, hooked }).toEqual({ built: 1, hooked: ["alpha", "beta"] });
  });

  it("serves one implementation through bindings of its own, each routing what it holds", async () => {
    let built = 0;

    const app = Action.implement(
      [Alpha, Beta, Audit],
      Effect.sync(() => {
        built++;

        return {
          alpha: () => Effect.succeed("alpha"),
          beta: () => Effect.succeed("beta"),
          audit: () => Effect.succeed("audit"),
        };
      }),
      Action.allowAll,
    );

    const Reads = ActionHttp.make([Alpha, Audit], { prefix: "/reads" });
    const Writes = ActionHttp.make([Beta], { prefix: "/writes" });

    const handler = serve(
      Layer.mergeAll(ActionHttp.layer(Reads, app), ActionHttp.layer(Writes, app)),
    ).handler;

    const answers = await Promise.all(
      ["/reads/alpha", "/reads/audit", "/writes/beta", "/reads/beta", "/writes/alpha"].map(
        async (path) => {
          const response = await handler(post(path));

          return response.status === 200 ? await response.json() : response.status;
        },
      ),
    );

    expect(answers).toEqual(["alpha", "audit", "beta", 404, 404]);
    expect(built).toBe(1);
  });

  it("serves a route and another contract's tool of the same name side by side", async () => {
    const Search = Action.make("search", {
      description: "Search the site",
      access: "read",
      input: { query: Schema.String },
      success: Schema.String,
    });

    const AgentSearch = Action.make("search", {
      description: "Search the agent's notes",
      access: "read",
      input: { topic: Schema.String },
      success: Schema.String,
    });

    const web = Action.implement(
      Search,
      ({ query }) => Effect.succeed(`site:${query}`),
      Action.allowAll,
    );

    // The agent's `search` is not the binding's: HTTP leaves it, and its name, to MCP.
    const agent = Action.implement(
      [Alpha, AgentSearch],
      {
        alpha: () => Effect.succeed("alpha"),
        search: ({ topic }) => Effect.succeed(`notes:${topic}`),
      },
      Action.allowAll,
    );

    const routes = serve(
      Layer.mergeAll(
        ActionHttp.layer(ActionHttp.make([Search, Alpha]), [web, agent]),
        ActionMcp.layerHttp(agent, { name: "test", version: "0" }),
      ),
    );

    expect(await (await routes.handler(post("/api/search", { query: "x" }))).json()).toBe("site:x");

    const tool = await routes.handler(rawToolCall("search", { topic: "y" }));

    expect(await tool.json()).toMatchObject({ result: { structuredContent: "notes:y" } });
  });

  it("serves one binding's actions through several layers; an unserved action has no route", async () => {
    const bound = ActionHttp.make([Alpha, Beta, Audit]);

    const handler = serve(
      Layer.mergeAll(
        ActionHttp.layer(
          bound,
          Action.implement(Alpha, () => Effect.succeed("alpha"), Action.allowAll),
        ),
        ActionHttp.layer(
          bound,
          Action.implement(Beta, () => Effect.succeed("beta"), Action.allowAll),
        ),
      ),
    ).handler;

    expect(await (await handler(post("/api/alpha"))).json()).toBe("alpha");
    expect(await (await handler(post("/api/beta"))).json()).toBe("beta");
    expect((await handler(post("/api/audit"))).status).toBe(404);
    // The document still describes the whole binding.
    expect(Object.keys(OpenApi.fromApi(bound.api).paths)).toEqual([
      "/api/alpha",
      "/api/beta",
      "/api/audit",
    ]);
  });

  it("scopes router middleware to the layer it is provided to", async () => {
    // Replaces the response of every route it covers.
    const blocked = HttpRouter.middleware((route) =>
      Effect.as(route, HttpServerResponse.text("blocked", { status: 403 })),
    ).layer;

    const users = ActionHttp.layer(Http, whoAmI).pipe(Layer.provide(Layer.succeed(Tenant, "acme")));
    const invoices = ActionHttp.layer(Http, billing);

    const statuses = async (handler: (request: Request) => Promise<Response>) => [
      (await handler(post("/api/whoAmI"))).status,
      (await handler(post("/api/invoice", { amount: "2" }))).status,
    ];

    // Each layer registers its own routes, so a guard covers exactly what it is provided to.
    expect(
      await statuses(serve(Layer.mergeAll(users.pipe(Layer.provide(blocked)), invoices)).handler),
    ).toEqual([403, 200]);
    expect(
      await statuses(serve(Layer.mergeAll(users, invoices.pipe(Layer.provide(blocked)))).handler),
    ).toEqual([200, 403]);
    expect(
      await statuses(serve(Layer.mergeAll(users, invoices).pipe(Layer.provide(blocked))).handler),
    ).toEqual([403, 403]);
  });

  it("declares a shared error array on every action that spreads it, on both transports", async () => {
    class Refused extends Schema.TaggedError<Refused>()(
      "Refused",
      { reason: Schema.String },
      { httpApiStatus: 403 },
    ) {}

    class Missing extends Schema.TaggedError<Missing>()("Missing", {}, { httpApiStatus: 404 }) {}

    const shared = [Refused] as const;

    const Find = Action.make("find", {
      description: "Find",
      access: "write",
      success: Schema.String,
      errors: [Missing, ...shared],
    });

    const List = Action.make("list", {
      description: "List",
      access: "write",
      success: Schema.String,
      errors: [...shared],
    });

    const apps = Action.implement(
      [Find, List],
      {
        find: () => Effect.fail(new Missing()),
        list: () => Effect.fail(new Refused({ reason: "closed" })),
      },
      Action.allowAll,
    );

    const bound = ActionHttp.make([Find, List]);

    const handler = serve(
      Layer.mergeAll(
        ActionHttp.layer(bound, apps),
        ActionMcp.layerHttp(apps, { name: "test", version: "0" }),
      ),
    ).handler;

    expect((await handler(post("/api/find"))).status).toBe(404);
    const refused = await handler(post("/api/list"));
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual(
      Schema.encodeSync(Refused)(new Refused({ reason: "closed" })),
    );

    const tool = await handler(rawToolCall("list"));

    // A TaggedError without a message is shown as its encoding.
    const reply: unknown = await tool.json();
    expect(reply).toMatchObject({
      result: {
        isError: true,
        content: [{ type: "text", text: '{"_tag":"Refused","reason":"closed"}' }],
      },
    });
    expect(reply).not.toHaveProperty("result.structuredContent");
    expect(OpenApi.fromApi(bound.api).paths["/api/list"]?.post?.responses).toHaveProperty("403");
  });
});

describe("documented security", () => {
  const schemes = {
    bearer: HttpApiSecurity.bearer,
    key: HttpApiSecurity.apiKey({ key: "x-api-key" }),
  };

  const Secured = ActionHttp.make([WhoAmI, Invoice, Audit], {
    security: schemes,
    public: [WhoAmI],
  });

  const Ping = Action.make("ping", { description: "Ping", access: "read", success: Schema.String });

  /** Each operation's security requirements in `document`, by path. */
  const requirements = (document: OpenApi.OpenAPISpec) =>
    Object.fromEntries(
      Object.entries(document.paths).map(([path, item]) => [path, item.post?.security]),
    );

  it("states the schemes on every endpoint but the public ones, any one of them sufficing", () => {
    expect(OpenApi.fromApi(Secured.api).components.securitySchemes).toEqual({
      bearer: { type: "http", scheme: "Bearer" },
      key: { type: "apiKey", name: "x-api-key", in: "header" },
    });
    expect(requirements(OpenApi.fromApi(Secured.api))).toEqual({
      "/api/whoAmI": [],
      "/api/invoice": [{ bearer: [] }, { key: [] }],
      "/api/audit": [{ bearer: [] }, { key: [] }],
    });
    // Without `security` there is nothing to state, `public` or not.
    const open = ActionHttp.make([WhoAmI, Invoice], { public: [WhoAmI] });

    expect(requirements(OpenApi.fromApi(open.api))).toEqual({
      "/api/whoAmI": [],
      "/api/invoice": [],
    });
  });

  it("keeps each binding's schemes in one document for several", () => {
    const combined = HttpApi.make("host")
      .addHttpApi(Secured.api)
      .addHttpApi(ActionHttp.make([Ping], { prefix: "/open" }).api);

    expect(requirements(OpenApi.fromApi(combined))).toEqual({
      "/api/whoAmI": [],
      "/api/invoice": [{ bearer: [] }, { key: [] }],
      "/api/audit": [{ bearer: [] }, { key: [] }],
      "/open/ping": [],
    });

    // One name, two schemes: Effect refuses to document either.
    const conflicting = HttpApi.make("host")
      .addHttpApi(Secured.api)
      .addHttpApi(
        ActionHttp.make([Ping], {
          prefix: "/open",
          security: { bearer: HttpApiSecurity.basic },
        }).api,
      );

    expect(() => OpenApi.fromApi(conflicting)).toThrow("Conflicting OpenAPI security scheme");
  });

  it.effect("enforces nothing: served without authentication, every route answers any caller", () =>
    Effect.gen(function* () {
      expect(yield* (yield* send(post("/api/invoice", { amount: "2" }))).json).toBe(4);
      expect(yield* (yield* send(post("/api/audit"))).json).toBe("clean");

      // The native client of the documented API calls it as it calls any binding.
      const client = yield* HttpApiClient.make(Secured.api, { baseUrl: "http://localhost" });

      expect([
        yield* client.whoAmI({ payload: {} }),
        yield* client.invoice({ payload: { amount: 3 } }),
      ]).toEqual(["ada@acme", 6]);
    }).pipe(
      Effect.provide(
        Testing.layer(
          ActionHttp.layer(Secured, [whoAmI, billing]).pipe(
            Layer.provide(Layer.succeed(Tenant, "acme")),
          ),
        ),
      ),
    ),
  );
});
