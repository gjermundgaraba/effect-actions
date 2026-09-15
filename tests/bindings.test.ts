import { describe, expect, it } from "vite-plus/test";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { Context, Effect, Layer, Logger, Schema, Tracer } from "effect";
import { HttpRouter, HttpServer } from "effect/unstable/http";
import { Action, ActionGroup, ActionHttp, ActionMcp } from "../src/index.js";

class Actor extends Context.Service<Actor, string>()("bindings/Actor") {}

const identity = Action.make("identity", {
  description: "Request identity",
  success: Schema.String,
});
const post = (path: string) =>
  new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });

describe.each(["HTTP", "legacy MCP", "modern MCP"] as const)(
  "context isolation: %s",
  (transport) => {
    it.each([false, true])(
      "with a build-only actor; request actor present: %s",
      async (present) => {
        let executions = 0;
        const app = ActionGroup.make(identity).implement({
          identity: () =>
            Effect.gen(function* () {
              const actor = yield* Actor;
              yield* Effect.sync(() => executions++);
              return actor;
            }),
        });
        const routes =
          transport === "HTTP"
            ? ActionHttp.layer(app)
            : ActionMcp.layer(app, { name: "test", version: "0" });
        const web = HttpRouter.toWebHandler(
          routes.pipe(
            Layer.provide(Layer.succeed(Actor, "startup-admin")),
            Layer.provide(HttpServer.layerServices),
          ),
          { disableLogger: true },
        );
        const fetch = (request: Request) => {
          if (present) return web.handler(request, Context.make(Actor, "request-reader"));
          // @ts-expect-error Deliberately misconfigured host: runtime must not inherit the build-only actor.
          return web.handler(request, Context.empty());
        };
        const client = new Client(
          { name: "test", version: "0" },
          {
            versionNegotiation: {
              mode: transport === "modern MCP" ? { pin: "2026-07-28" } : "legacy",
            },
          },
        );
        try {
          if (transport === "HTTP") {
            const response = await fetch(post("/api/actions/identity"));
            expect(response.status).toBe(present ? 200 : 500);
            expect(await response.text()).toBe(present ? '"request-reader"' : "");
          } else {
            await client.connect(
              new StreamableHTTPClientTransport(new URL("http://localhost/mcp"), {
                fetch: (input, init) => fetch(new Request(input, init)),
              }),
            );
            const call = client.callTool({ name: "identity", arguments: {} });
            if (present) {
              expect((await call).structuredContent).toEqual({ value: "request-reader" });
            } else {
              await expect(call).rejects.toThrow("Internal error");
            }
          }
          expect(executions).toBe(present ? 1 : 0);
        } finally {
          await client.close();
          await web.dispose();
        }
      },
    );
  },
);

it.each(["legacy", "modern"] as const)(
  "shares one scoped handler build across transports: %s",
  async (era) => {
    let acquired = 0;
    let finalized = 0;
    const app = ActionGroup.make(identity).implement(
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
      ActionHttp.layer(app),
      ActionMcp.layer(app, { name: "test", version: "0" }),
    ).pipe(Layer.provide(Layer.succeed(Actor, "build")), Layer.provide(HttpServer.layerServices));
    // Reuse the same implementation in separate runtimes: memoization must not
    // become process-global, and each acquisition must have its own finalizer.
    for (let runtime = 1; runtime <= 2; runtime++) {
      const web = HttpRouter.toWebHandler(routes, { disableLogger: true });
      const client = new Client(
        { name: "test", version: "0" },
        {
          versionNegotiation: { mode: era === "modern" ? { pin: "2026-07-28" } : "legacy" },
        },
      );
      try {
        const response = await web.handler(
          post("/api/actions/identity"),
          Context.make(Actor, "http"),
        );
        expect(await response.json()).toBe("build/http");
        await client.connect(
          new StreamableHTTPClientTransport(new URL("http://localhost/mcp"), {
            fetch: (input, init) =>
              web.handler(new Request(input, init), Context.make(Actor, "mcp")),
          }),
        );
        expect(
          (await client.callTool({ name: "identity", arguments: {} })).structuredContent,
        ).toEqual({ value: "build/mcp" });
        expect(acquired).toBe(runtime);
        expect(finalized).toBe(runtime - 1);
      } finally {
        await client.close();
        await web.dispose();
      }
      expect(finalized).toBe(runtime);
    }
  },
);

it.each(["legacy", "modern"] as const)(
  "keeps same-contract implementations apart over MCP: %s",
  async (era) => {
    const group = ActionGroup.make(identity);
    const a = group.implement({ identity: () => Effect.succeed("a") });
    const b = group.implement({ identity: () => Effect.succeed("b") });
    const web = HttpRouter.toWebHandler(
      Layer.mergeAll(
        ActionMcp.layer(a, { name: "a", version: "0", path: "/a" }),
        ActionMcp.layer(b, { name: "b", version: "0", path: "/b" }),
      ).pipe(Layer.provide(HttpServer.layerServices)),
      { disableLogger: true },
    );
    try {
      for (const name of ["a", "b", "a"]) {
        const client = new Client(
          { name: "test", version: "0" },
          {
            versionNegotiation: { mode: era === "modern" ? { pin: "2026-07-28" } : "legacy" },
          },
        );
        try {
          await client.connect(
            new StreamableHTTPClientTransport(new URL(`http://localhost/${name}`), {
              fetch: (input, init) => web.handler(new Request(input, init)),
            }),
          );
          expect(
            (await client.callTool({ name: "identity", arguments: {} })).structuredContent,
          ).toEqual({ value: name });
        } finally {
          await client.close();
        }
      }
    } finally {
      await web.dispose();
    }
  },
);

it("releases scoped handler acquisition when native registration fails", async () => {
  let acquired = 0;
  let finalized = 0;
  const invalid = Action.make("invalid", {
    description: "Non-object MCP input",
    input: Schema.String,
    success: Schema.String,
  });
  const app = ActionGroup.make(invalid).implement(
    Effect.acquireRelease(
      Effect.sync(() => {
        acquired++;
        return { invalid: Effect.succeed };
      }),
      () => Effect.sync(() => finalized++),
    ),
  );
  const layer = ActionMcp.layer(app, { name: "test", version: "0" }).pipe(
    Layer.provide(HttpRouter.layer),
  );
  await expect(Effect.runPromise(Layer.build(layer).pipe(Effect.scoped))).rejects.toThrow(
    "MCP input must have an object root",
  );
  expect(acquired).toBe(1);
  expect(finalized).toBe(1);
});

it.each(["HTTP", "legacy MCP", "modern MCP"] as const)(
  "retains request logging and tracing: %s",
  async (transport) => {
    const logs: unknown[] = [];
    const spans: string[] = [];
    const logger = Logger.make((options) => logs.push(options.message));
    const tracer = Tracer.make({
      span(options) {
        spans.push(options.name);
        return Tracer.nativeTracer.span(options);
      },
    });
    const app = ActionGroup.make(identity).implement({
      identity: () =>
        Effect.log("handler ran").pipe(Effect.as("ok"), Effect.withSpan("action.identity")),
    });
    const routes =
      transport === "HTTP"
        ? ActionHttp.layer(app)
        : ActionMcp.layer(app, { name: "test", version: "0" });
    const web = HttpRouter.toWebHandler(routes.pipe(Layer.provide(HttpServer.layerServices)), {
      disableLogger: true,
    });
    const context = Context.make(Logger.CurrentLoggers, new Set([logger])).pipe(
      Context.add(Tracer.Tracer, tracer),
    );
    const client = new Client(
      { name: "test", version: "0" },
      {
        versionNegotiation: { mode: transport === "modern MCP" ? { pin: "2026-07-28" } : "legacy" },
      },
    );
    try {
      if (transport === "HTTP") {
        expect(await (await web.handler(post("/api/actions/identity"), context)).json()).toBe("ok");
      } else {
        await client.connect(
          new StreamableHTTPClientTransport(new URL("http://localhost/mcp"), {
            fetch: (input, init) => web.handler(new Request(input, init), context),
          }),
        );
        expect(
          (await client.callTool({ name: "identity", arguments: {} })).structuredContent,
        ).toEqual({ value: "ok" });
      }
      expect(logs).toContainEqual(["handler ran"]);
      expect(spans).toContain("action.identity");
    } finally {
      await client.close();
      await web.dispose();
    }
  },
);
