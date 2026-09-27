import { describe, expect, it, onTestFinished } from "vite-plus/test";
import { Context, Effect, Layer, Logger, Option, References, Schema, Tracer } from "effect";
import { HttpRouter } from "effect/unstable/http";
import * as Action from "../src/Action.js";
import * as ActionHttp from "../src/ActionHttp.js";
import * as ActionMcp from "../src/ActionMcp.js";
import { withMcpClient } from "./mcp-client.js";
import { post, rawToolCall } from "./requests.js";
import { serveWithContext } from "./server.js";
import { serve } from "./serve.js";

class Actor extends Context.Service<Actor, string>()("bindings/Actor") {}

const identity = Action.make("identity", {
  description: "Request identity",
  access: "write",
  success: Schema.String,
});

// Build capabilities and request identities have distinct tags.
class Greeting extends Context.Service<Greeting, string>()("bindings/Greeting") {}

it.each(["HTTP", "MCP"])("fails without request identity over %s", async (transport) => {
  const app = Action.implement(identity, () => Actor);

  const routes =
    transport === "HTTP"
      ? ActionHttp.layer(ActionHttp.make([identity]), app)
      : ActionMcp.layerHttp(app, {
          name: "test",
          version: "0",
        });

  // The request identity these routes require is deliberately missing.
  const web = serveWithContext(routes);

  onTestFinished(() => web.dispose());

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
          ).toEqual({ value: "build/mcp" });
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

it("builds a shared implementation with one set of startup services, not one per surface", async () => {
  const app = Action.implement(
    identity,
    Effect.map(Greeting, (greeting) => () => Effect.succeed(greeting)),
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

  onTestFinished(() => web.dispose());

  const http = await (await web.handler(post("/api/identity"))).json();

  await withMcpClient({ fetch: web.handler }, async (client) => {
    expect((await client.callTool({ name: "identity", arguments: {} })).structuredContent).toEqual({
      value: http,
    });
  });
});

it("serves a copy of a binding like the binding itself", async () => {
  const Http = ActionHttp.make([identity], { prefix: "/v1" });
  const app = Action.implement(identity, () => Effect.succeed("copied"));

  const web = serve(
    Layer.mergeAll(ActionHttp.layer({ ...Http }, app), ActionHttp.openApi({ ...Http })),
  );

  onTestFinished(() => web.dispose());

  expect(await (await web.handler(post("/v1/identity"))).json()).toBe("copied");
  expect((await web.handler(new Request("http://localhost/v1/openapi.json"))).status).toBe(200);
});

it("mounts routes and the OpenAPI document under the binding's prefix, even with no actions", async () => {
  expect(ActionHttp.make([identity]).prefix).toBe("/api");
  expect(ActionHttp.make([identity], { prefix: "/v1/" }).prefix).toBe("/v1");
  expect(ActionHttp.make([identity], { prefix: "/" }).prefix).toBe("");

  const Empty = ActionHttp.make([], { prefix: "/empty" });

  const web = serve(
    Layer.mergeAll(
      ActionHttp.layer(Empty, []),
      ActionHttp.openApi(Empty),
      ActionHttp.openApi(ActionHttp.make([], { prefix: "/" })),
    ),
  );

  onTestFinished(() => web.dispose());

  expect((await web.handler(new Request("http://localhost/empty/openapi.json"))).status).toBe(200);
  expect((await web.handler(new Request("http://localhost/openapi.json"))).status).toBe(200);
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
  const a = Action.implement(identity, () => Effect.succeed("a"));
  const b = Action.implement(identity, () => Effect.succeed("b"));

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

  onTestFinished(() => web.dispose());

  for (const name of ["a", "b", "a"]) {
    await withMcpClient({ fetch: web.handler, path: `/${name}` }, async (client) => {
      expect(
        (await client.callTool({ name: "identity", arguments: {} })).structuredContent,
      ).toEqual({ value: name });
    });
  }
});

describe.each(["HTTP", "MCP"] as const)("request logging and tracing: %s", (transport) => {
  // The MCP span name carries the protocol revision.
  const requestSpan = transport === "HTTP" ? /^http\.server POST$/ : /^McpServer\..*tools\/call$/;

  const run = async (
    handler: () => Effect.Effect<string>,
    before?: Action.Before<typeof identity, never>,
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

    onTestFinished(() => web.dispose());

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
    const app = Action.implement(identity, () => Actor);

    const routes =
      transport === "HTTP"
        ? ActionHttp.layer(ActionHttp.make([identity]), app)
        : ActionMcp.layerHttp(app, {
            name: "test",
            version: "0",
          });

    const web = serve(routes.pipe(HttpRouter.provideRequest(Layer.succeed(Actor, "request"))));

    onTestFinished(() => web.dispose());

    const response = await web.handler(
      transport === "HTTP" ? post("/api/identity") : rawToolCall("identity"),
    );

    expect(response.status).toBe(200);

    if (transport === "HTTP") {
      expect(await response.json()).toBe("request");
    } else {
      expect(await response.json()).toMatchObject({
        result: { structuredContent: { value: "request" } },
      });
    }
  },
);
