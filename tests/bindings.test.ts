import { describe, expect, it } from "vite-plus/test";
import { Context, Effect, Layer, Logger, Option, References, Schema, Stream, Tracer } from "effect";
import { HttpRouter } from "effect/http";
import * as Action from "../src/Action.js";
import * as ActionHttp from "../src/ActionHttp.js";
import * as ActionMcp from "../src/ActionMcp.js";
import * as ActionToolkit from "../src/ActionToolkit.js";
import * as Testing from "../src/Testing.js";
import { withMcpClient } from "./mcp-client.js";
import { post, rawToolCall } from "./requests.js";
import { against, type Server, serve, serveWithContext } from "./serve.js";

class Actor extends Context.Service<Actor, string>()("bindings/Actor") {}

const identity = Action.make("identity", {
  description: "Request identity",
  access: "write",
  success: Schema.String,
});

// Build capabilities and request identities have distinct tags.
class Greeting extends Context.Service<Greeting, string>()("bindings/Greeting") {}

it.each(["HTTP", "MCP"])("fails without request identity over %s", async (transport) => {
  const app = Action.implement(identity, () => Actor, Action.allowAll);

  const routes =
    transport === "HTTP"
      ? ActionHttp.layer(ActionHttp.make([identity]), app)
      : ActionMcp.layerHttp(app, {
          name: "test",
          version: "0",
        });

  // The request identity these routes require is deliberately missing.
  const web = serveWithContext(routes);

  const request = transport === "HTTP" ? post("/api/identity") : rawToolCall("identity");

  // @ts-expect-error Deliberately omit the required request identity to exercise runtime failure.
  const response = await web.handler(request, Context.empty());

  if (transport === "HTTP") {
    expect(response.status).toBe(500);
    expect(await response.text()).toBe("");
  } else {
    expect(await response.json()).toMatchObject({ result: { isError: true } });
  }
});

it("builds an implementation once per host build, however many adapters serve it", async () => {
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

it("shares an implementation's builder with some of its actions, behind its hook or another", async () => {
  let built = 0;

  const secret = Action.make("secret", {
    description: "Only for the trusted",
    access: "read",
    success: Schema.String,
  });

  // The source refuses every call.
  const app = Action.implement(
    [identity, secret],
    Effect.sync(() => {
      built++;

      return { identity: () => Effect.succeed("shared"), secret: () => Effect.succeed("hidden") };
    }),
    () => Effect.fail(new Action.Forbidden()),
  );

  // Without a hook of its own, a shared implementation keeps its source's; with one, that
  // one runs instead.
  const kept = Action.share([identity], app);
  const open = Action.share([identity], app, Action.allowAll);

  expect(open.actions).toEqual([identity]);

  const web = serve(
    Layer.mergeAll(
      ActionHttp.layer(ActionHttp.make([identity, secret]), app),
      ActionHttp.layer(ActionHttp.make([identity], { prefix: "/kept" }), kept),
      ActionHttp.layer(ActionHttp.make([identity], { prefix: "/open" }), open),
    ),
  );

  expect((await web.handler(post("/api/secret"))).status).toBe(403);
  expect((await web.handler(post("/kept/identity"))).status).toBe(403);
  expect(await (await web.handler(post("/open/identity"))).json()).toBe("shared");
  // Three implementations, one builder run.
  expect(built).toBe(1);

  // Plain JavaScript may pass an action the source does not implement.
  const stranger: Action.Any = Action.make("stranger", { description: "", access: "read" });

  // @ts-expect-error Only the source's own actions.
  expect(() => Action.share([stranger], open)).toThrow(
    "Not implemented by this implementation: stranger",
  );
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
  const call = (web: Server, path: string, name: "identity" | "secret") =>
    against(
      web,
      Effect.flatMap(Testing.mcpClient([identity, secret], { url: path }), (mcp) =>
        mcp[name]().pipe(Effect.catchTag("Forbidden", ({ _tag }) => Effect.succeed(_tag))),
      ),
    );

  it("runs the builder once for an implementation and its shares, with and without another hook, on every surface", async () => {
    const { runs, app } = counted(() => Effect.fail(new Action.Forbidden()));
    const kept = Action.share([identity], app);
    const open = Action.share([identity], app, Action.allowAll);

    const web = serve(
      Layer.mergeAll(
        ActionHttp.layer(Http, app),
        ActionHttp.layer(ActionHttp.make([identity], { prefix: "/kept" }), kept),
        ActionHttp.layer(ActionHttp.make([identity], { prefix: "/open" }), open),
        ActionMcp.layerHttp(kept, { name: "kept", version: "0", path: "/mcp/kept" }),
        ActionMcp.layerHttp(open, { name: "open", version: "0", path: "/mcp/open" }),
        ActionToolkit.make([kept, Action.share([secret], app, Action.allowAll)]).layer,
      ),
    );

    expect((await web.handler(post("/kept/identity"))).status).toBe(403);
    expect(await (await web.handler(post("/open/identity"))).json()).toBe("shared");
    expect(await call(web, "/mcp/kept", "identity")).toBe("Forbidden");
    expect(await call(web, "/mcp/open", "identity")).toBe("shared");
    // Five implementations on three surfaces, one builder run.
    expect(runs.built).toBe(1);
  });

  it("runs each hook for its own actions, without building the shared handlers again", async () => {
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

    const web = serve(
      Layer.mergeAll(
        ActionHttp.layer(Http, app),
        ActionHttp.layer(ActionHttp.make([secret], { prefix: "/admin" }), admin),
        ActionMcp.layerHttp(admin, { name: "admin", version: "0" }),
      ),
    );

    expect(await (await web.handler(post("/api/identity"))).json()).toBe("shared");
    expect(await (await web.handler(post("/api/secret"))).json()).toBe("hidden");
    expect(await (await web.handler(post("/admin/secret"))).json()).toBe("hidden");
    expect(await call(web, "/mcp", "secret")).toBe("hidden");
    expect(hooks).toEqual(["source identity", "source secret", "admin secret", "admin secret"]);
    expect(runs.built).toBe(1);
  });

  it("builds a share's own built hook once, and never runs its source's builder again for it", async () => {
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

    const both = serve(
      Layer.mergeAll(
        ActionHttp.layer(Http, app),
        // A share given no hook keeps its source's, built once for both.
        ActionHttp.layer(
          ActionHttp.make([identity], { prefix: "/kept" }),
          Action.share([identity], app),
        ),
        ActionHttp.layer(ActionHttp.make([identity], { prefix: "/open" }), open),
        ActionMcp.layerHttp(open, { name: "open", version: "0" }),
      ),
    );

    expect((await both.handler(post("/api/identity"))).status).toBe(403);
    expect((await both.handler(post("/kept/identity"))).status).toBe(403);
    expect(await (await both.handler(post("/open/identity"))).json()).toBe("shared");
    expect(await call(both, "/mcp", "identity")).toBe("shared");
    expect({ ...runs, ...builds }).toEqual({ built: 1, sourceHook: 1, openHook: 1 });

    // Served alone, a share with a hook of its own builds its source's handlers, not its hook.
    const alone = serve(ActionHttp.layer(ActionHttp.make([identity]), open));

    expect(await (await alone.handler(post("/api/identity"))).json()).toBe("shared");
    expect({ ...runs, ...builds }).toEqual({ built: 2, sourceHook: 1, openHook: 2 });
  });
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

it("builds once beside routes served apart, when Action.layer is provided above both", async () => {
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

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const client = yield* ActionHttp.client(ActionHttp.make([Count]));
          const toolkit = yield* tools.toolkit;

          yield* client.count();
          yield* Stream.runCollect(yield* toolkit.handle("count", {}));
        }).pipe(Effect.provide(layers)),
      ),
    );

    expect([order, built, hooked]).toEqual([order, 1, 1]);
  }
});

it("serves a copy of a binding like the binding itself", async () => {
  const Http = ActionHttp.make([identity], { prefix: "/v1" });
  const app = Action.implement(identity, () => Effect.succeed("copied"), Action.allowAll);

  const web = serve(ActionHttp.layer({ ...Http }, app));

  expect(await (await web.handler(post("/v1/identity"))).json()).toBe("copied");
});

it("serves a binding with no actions", async () => {
  const web = serve(ActionHttp.layer(ActionHttp.make([], { prefix: "/empty" }), []));

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
