import { describe, expect, it, onTestFinished } from "vite-plus/test";
import { Context, Effect, Layer, Logger, Option, Schema, Tracer } from "effect";
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
  success: Schema.String,
});

// Both native builders hand their build context to handlers; each adapter registers
// without it, so a startup copy never shadows the request's own service. Only HTTP
// also refuses to fall back to it when the request omits the service: the MCP route
// keeps its layer context, and the types require the request to provide the service.
describe.each([
  ["HTTP", [false, true]],
  ["MCP", [true]],
] as const)("%s never lets a build-only copy of a request service win", (transport, cases) => {
  it.each(cases)("request actor present: %s", async (present) => {
    let executions = 0;

    const app = ActionGroup.make({ name: "test" }, identity).implement({
      identity: () => Effect.tap(Actor, () => Effect.sync(() => executions++)),
    });

    const routes =
      transport === "HTTP"
        ? ActionHttp.make({ apiPath: testApiPath }, app.group).layer(app)
        : ActionMcp.layer({ name: "test", version: "0", path: testMcpPath }, app);

    const web = HttpRouter.toWebHandler(
      routes.pipe(
        Layer.provide(Layer.succeed(Actor, "startup-admin")),
        Layer.provide(HttpServer.layerServices),
      ),
      { disableLogger: true },
    );

    onTestFinished(() => web.dispose());

    const request =
      transport === "HTTP"
        ? post("/api/actions/identity")
        : mcpRequest({
            url: testMcpUrl,
            method: "tools/call",
            params: { name: "identity", arguments: {} },
          });

    const response = present
      ? await web.handler(request, Context.make(Actor, "request-reader"))
      : // @ts-expect-error Deliberately misconfigured host: the request service is absent at runtime.
        await web.handler(request, Context.empty());

    const body = await response.text();

    if (transport === "HTTP") {
      expect(response.status).toBe(present ? 200 : 500);
      expect(body).toBe(present ? '"request-reader"' : "");
    } else {
      expect(response.status).toBe(200);
      expect(body).toContain(present ? '"value":"request-reader"' : '"isError":true');
    }

    expect(body).not.toContain("startup-admin");
    expect(executions).toBe(present ? 1 : 0);
  });
});

it.each(["legacy", "modern"] as const)(
  "each adapter layer acquires and releases its own handler build: %s",
  async (era) => {
    let acquired = 0;
    let finalized = 0;

    const app = ActionGroup.make({ name: "test" }, identity).implement(
      Effect.gen(function* () {
        const greeting = yield* Effect.acquireRelease(
          Effect.gen(function* () {
            yield* Effect.sync(() => acquired++);

            return yield* Actor;
          }),
          () => Effect.sync(() => finalized++),
        );

        return { identity: () => Effect.map(Actor, (actor) => `${greeting}/${actor}`) };
      }),
    );

    const routes = Layer.mergeAll(
      ActionHttp.make({ apiPath: testApiPath }, app.group).layer(app),
      ActionMcp.layer({ name: "test", version: "0", path: testMcpPath }, app),
    ).pipe(Layer.provide(Layer.succeed(Actor, "build")), Layer.provide(HttpServer.layerServices));

    // Two adapters serve the implementation, so each runtime acquires twice.
    // Reusing the implementation across runtimes must not share state either.
    for (let runtime = 1; runtime <= 2; runtime++) {
      const web = HttpRouter.toWebHandler(routes, { disableLogger: true });

      try {
        const response = await web.handler(
          post("/api/actions/identity"),
          Context.make(Actor, "http"),
        );

        expect(await response.json()).toBe("build/http");
        await withMcpClient(
          {
            fetch: (request) => web.handler(request, Context.make(Actor, "mcp")),
            mode: era,
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
  },
);

it.each(["legacy", "modern"] as const)(
  "keeps same-contract implementations apart over MCP: %s",
  async (era) => {
    const group = ActionGroup.make({ name: "test" }, identity);
    const a = group.implement({ identity: () => Effect.succeed("a") });
    const b = group.implement({ identity: () => Effect.succeed("b") });

    const web = HttpRouter.toWebHandler(
      Layer.mergeAll(
        ActionMcp.layer({ name: "a", version: "0", path: "/a" }, a),
        ActionMcp.layer({ name: "b", version: "0", path: "/b" }, b),
      ).pipe(Layer.provide(HttpServer.layerServices)),
      { disableLogger: true },
    );

    onTestFinished(() => web.dispose());

    for (const name of ["a", "b", "a"]) {
      await withMcpClient({ fetch: web.handler, mode: era, path: `/${name}` }, async (client) => {
        expect(
          (await client.callTool({ name: "identity", arguments: {} })).structuredContent,
        ).toEqual({ value: name });
      });
    }
  },
);

describe.each(["HTTP", "legacy MCP", "modern MCP"] as const)(
  "request logging and tracing: %s",
  (transport) => {
    // The MCP span name carries the negotiated protocol revision.
    const requestSpan = transport === "HTTP" ? /^http\.server POST$/ : /^McpServer\..*tools\/call$/;

    const run = async (handler: () => Effect.Effect<string>) => {
      const logs: unknown[] = [];
      const parents = new Map<string, string | undefined>();
      const logger = Logger.make((options) => logs.push(options.message));

      const tracer = Tracer.make({
        span(options) {
          const parent = Option.getOrUndefined(options.parent);

          parents.set(options.name, parent?._tag === "Span" ? parent.name : undefined);

          return Tracer.nativeTracer.span(options);
        },
      });

      const app = ActionGroup.make({ name: "test" }, identity).implement({ identity: handler });

      const routes =
        transport === "HTTP"
          ? ActionHttp.make({ apiPath: testApiPath }, app.group).layer(app)
          : ActionMcp.layer({ name: "test", version: "0", path: testMcpPath }, app);

      const web = HttpRouter.toWebHandler(routes.pipe(Layer.provide(HttpServer.layerServices)), {
        disableLogger: true,
      });

      const context = Context.make(Logger.CurrentLoggers, new Set([logger])).pipe(
        Context.add(Tracer.Tracer, tracer),
      );

      onTestFinished(() => web.dispose());

      if (transport === "HTTP") {
        await web.handler(post("/api/actions/identity"), context);
      } else {
        await withMcpClient(
          {
            fetch: (request) => web.handler(request, context),
            mode: transport === "modern MCP" ? "modern" : "legacy",
            path: testMcpPath,
          },
          (client) => client.callTool({ name: "identity", arguments: {} }).catch(() => undefined),
        );
      }

      return { logs, parents };
    };

    it("runs the handler in an action span under the request span", async () => {
      const { logs, parents } = await run(() =>
        Effect.log("handler ran").pipe(Effect.as("ok"), Effect.withSpan("action.identity")),
      );

      expect(logs).toContainEqual(["handler ran"]);
      // The action span is named by the OpenAPI operation ID on both transports.
      expect(parents.get("action.identity")).toBe("test.identity");
      expect(parents.get("test.identity")).toMatch(requestSpan);
    });

    it("opens the action span even when the handler throws before returning an effect", async () => {
      const { parents } = await run(() => {
        throw new Error("boom");
      });

      expect(parents.get("test.identity")).toMatch(requestSpan);
    });
  },
);

describe.each(["HTTP", "MCP"])(
  "uses the request service, never a startup copy, over %s",
  (transport) => {
    class Who extends Context.Service<Who, string>()("test/Who") {}

    const Identity = Action.make("identity", {
      description: "Request identity",
      success: Schema.String,
    });

    const app = ActionGroup.make({ name: "test" }, Identity).implement({ identity: () => Who });
    const request = Layer.succeed(Who, "request");
    const startup = Layer.succeed(Who, "startup");

    const routes = () =>
      transport === "HTTP"
        ? ActionHttp.make({ apiPath: testApiPath }, app.group).layer(app)
        : ActionMcp.layer({ name: "test", version: "0", path: testMcpPath }, app);

    const call = async (web: { handler: (request: Request) => Promise<Response> }) => {
      const response = await web.handler(
        transport === "HTTP"
          ? post("/api/actions/identity")
          : mcpRequest({
              method: "tools/call",
              params: { name: "identity", arguments: {} },
              url: testMcpUrl,
            }),
      );

      expect(response.status).toBe(200);
      const body: unknown = await response.json();

      return transport === "HTTP"
        ? body
        : Schema.decodeUnknownSync(
            Schema.Struct({
              result: Schema.Struct({
                structuredContent: Schema.Struct({ value: Schema.String }),
              }),
            }),
          )(body).result.structuredContent.value;
    };

    it.each(["provided to the routes' build", "present in the runtime context"])(
      "with a startup copy %s",
      async (placement) => {
        const withRequest = routes().pipe(HttpRouter.provideRequest(request));

        const placed = placement.startsWith("provided")
          ? withRequest.pipe(Layer.provide(startup))
          : Layer.merge(withRequest, startup);

        const web = HttpRouter.toWebHandler(placed.pipe(Layer.provide(HttpServer.layerServices)), {
          disableLogger: true,
        });

        onTestFinished(() => web.dispose());
        expect(await call(web)).toBe("request");
      },
    );
  },
);
