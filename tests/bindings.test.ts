import { McpProtocol } from "effect/unstable/ai";
import { describe, expect, it, onTestFinished } from "vite-plus/test";
import { Context, Effect, Layer, Logger, Option, References, Schema, Tracer } from "effect";
import { HttpRouter, HttpServer } from "effect/unstable/http";
import * as Action from "../src/Action.js";
import * as ActionGroup from "../src/ActionGroup.js";
import * as ActionHttp from "../src/ActionHttp.js";
import * as ActionMcp from "../src/ActionMcp.js";
import { mcpRequest } from "../src/Testing.js";
import { withMcpClient } from "../src/TestingClient.js";
import { testApiPath, testMcpPath, testMcpUrl } from "./server.js";
import { post } from "./requests.js";

class Actor extends Context.Service<Actor, string>()("bindings/Actor") {}

const identity = Action.make("identity", {
  description: "Request identity",
  access: "write",
  success: Schema.String,
});

// Build capabilities and request identities have distinct tags.
class Greeting extends Context.Service<Greeting, string>()("bindings/Greeting") {}

it.each(["HTTP", "MCP"])("fails without request identity over %s", async (transport) => {
  let executions = 0;

  const app = ActionGroup.make({ name: "test" }, identity).implement({
    identity: () => Effect.tap(Actor, () => Effect.sync(() => executions++)),
  });

  const routes =
    transport === "HTTP"
      ? ActionHttp.make({ apiPath: testApiPath }, app.group).layer({}, app)
      : ActionMcp.layerHttp(
          { protocols: [McpProtocol.v2026_07_28], name: "test", version: "0", path: testMcpPath },
          app,
        );

  const web = HttpRouter.toWebHandler(routes.pipe(Layer.provide(HttpServer.layerServices)), {
    disableLogger: true,
  });

  onTestFinished(() => web.dispose());

  const request =
    transport === "HTTP"
      ? post("/api/actions/test/identity")
      : mcpRequest({
          url: testMcpUrl,
          method: "tools/call",
          params: { name: "identity", arguments: {} },
        });

  // @ts-expect-error Deliberately omit the required request identity to exercise runtime failure.
  const response = await web.handler(request, Context.empty());

  if (transport === "HTTP") {
    expect(response.status).toBe(500);
    expect(await response.text()).toBe("");
  } else {
    expect(await response.json()).toMatchObject({ result: { isError: true } });
  }

  expect(executions).toBe(0);
});

it("each adapter layer acquires and releases its own handler build", async () => {
  let acquired = 0;
  let finalized = 0;

  const app = ActionGroup.make({ name: "test" }, identity).implement(
    Effect.gen(function* () {
      const greeting = yield* Effect.acquireRelease(
        Effect.gen(function* () {
          yield* Effect.sync(() => acquired++);

          return yield* Greeting;
        }),
        () => Effect.sync(() => finalized++),
      );

      return { identity: () => Effect.map(Actor, (actor) => `${greeting}/${actor}`) };
    }),
  );

  const routes = Layer.mergeAll(
    ActionHttp.make({ apiPath: testApiPath }, app.group).layer({}, app),
    ActionMcp.layerHttp(
      { protocols: [McpProtocol.v2026_07_28], name: "test", version: "0", path: testMcpPath },
      app,
    ),
  ).pipe(Layer.provide(Layer.succeed(Greeting, "build")), Layer.provide(HttpServer.layerServices));

  // Two adapters serve the implementation, so each runtime acquires twice.
  // Reusing the implementation across runtimes must not share state either.
  for (let runtime = 1; runtime <= 2; runtime++) {
    const web = HttpRouter.toWebHandler(routes, { disableLogger: true });

    try {
      const response = await web.handler(
        post("/api/actions/test/identity"),
        Context.make(Actor, "http"),
      );

      expect(await response.json()).toBe("build/http");
      await withMcpClient(
        {
          versionNegotiation: { mode: { pin: "2026-07-28" } },
          fetch: (request) => web.handler(request, Context.make(Actor, "mcp")),
          path: testMcpPath,
        },
        async (client) => {
          expect(
            (await client.callTool({ name: "identity", arguments: {} })).structuredContent,
          ).toEqual({ value: "build/mcp" });
        },
      );
      expect(acquired).toBe(2 * runtime);
      expect(finalized).toBe(2 * (runtime - 1));
    } finally {
      await web.dispose();
    }

    expect(finalized).toBe(2 * runtime);
  }
});

it("keeps same-contract implementations apart over MCP", async () => {
  const group = ActionGroup.make({ name: "test" }, identity);
  const a = group.implement({ identity: () => Effect.succeed("a") });
  const b = group.implement({ identity: () => Effect.succeed("b") });

  const web = HttpRouter.toWebHandler(
    Layer.mergeAll(
      ActionMcp.layerHttp(
        { protocols: [McpProtocol.v2026_07_28], name: "a", version: "0", path: "/a" },
        a,
      ),
      ActionMcp.layerHttp(
        { protocols: [McpProtocol.v2026_07_28], name: "b", version: "0", path: "/b" },
        b,
      ),
    ).pipe(Layer.provide(HttpServer.layerServices)),
    { disableLogger: true },
  );

  onTestFinished(() => web.dispose());

  for (const name of ["a", "b", "a"]) {
    await withMcpClient(
      { versionNegotiation: { mode: { pin: "2026-07-28" } }, fetch: web.handler, path: `/${name}` },
      async (client) => {
        expect(
          (await client.callTool({ name: "identity", arguments: {} })).structuredContent,
        ).toEqual({ value: name });
      },
    );
  }
});

describe.each(["HTTP", "MCP"] as const)("request logging and tracing: %s", (transport) => {
  // The MCP span name carries the protocol revision.
  const requestSpan = transport === "HTTP" ? /^http\.server POST$/ : /^McpServer\..*tools\/call$/;

  const run = async (handler: () => Effect.Effect<string>) => {
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

    const app = ActionGroup.make({ name: "test" }, identity).implement({ identity: handler });

    const routes =
      transport === "HTTP"
        ? ActionHttp.make({ apiPath: testApiPath }, app.group).layer({}, app)
        : ActionMcp.layerHttp(
            { protocols: [McpProtocol.v2026_07_28], name: "test", version: "0", path: testMcpPath },
            app,
          );

    const web = HttpRouter.toWebHandler(routes.pipe(Layer.provide(HttpServer.layerServices)), {
      disableLogger: true,
    });

    const context = Context.make(Logger.CurrentLoggers, new Set([logger])).pipe(
      Context.add(Tracer.Tracer, tracer),
    );

    onTestFinished(() => web.dispose());

    if (transport === "HTTP") {
      await web.handler(post("/api/actions/test/identity"), context);
    } else {
      await withMcpClient(
        {
          versionNegotiation: { mode: { pin: "2026-07-28" } },
          fetch: (request) => web.handler(request, context),
          path: testMcpPath,
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
    // The action span is named by the OpenAPI operation ID on both transports.
    expect(parents.get("action.identity")).toBe("test.identity");
    expect(parents.get("test.identity")).toMatch(requestSpan);

    // The contract's identity is on the span and on every handler log line.
    const identity = new Map([
      ["action.group", "test"],
      ["action.name", "identity"],
      ["action.access", "write"],
    ]);

    expect(spans.get("test.identity")?.attributes).toEqual(identity);
    expect(annotations).toContainEqual(identity);
  });

  it("opens the action span even when the handler throws before returning an effect", async () => {
    const { parents } = await run(() => {
      throw new Error("boom");
    });

    expect(parents.get("test.identity")).toMatch(requestSpan);
  });
});

it.each(["HTTP", "MCP"])(
  "provides request identity through router wiring over %s",
  async (transport) => {
    const app = ActionGroup.make({ name: "test" }, identity).implement({ identity: () => Actor });

    const routes =
      transport === "HTTP"
        ? ActionHttp.make({ apiPath: testApiPath }, app.group).layer({}, app)
        : ActionMcp.layerHttp(
            { protocols: [McpProtocol.v2026_07_28], name: "test", version: "0", path: testMcpPath },
            app,
          );

    const web = HttpRouter.toWebHandler(
      routes.pipe(
        HttpRouter.provideRequest(Layer.succeed(Actor, "request")),
        Layer.provide(HttpServer.layerServices),
      ),
      { disableLogger: true },
    );

    onTestFinished(() => web.dispose());

    const response = await web.handler(
      transport === "HTTP"
        ? post("/api/actions/test/identity")
        : mcpRequest({
            method: "tools/call",
            params: { name: "identity", arguments: {} },
            url: testMcpUrl,
          }),
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
