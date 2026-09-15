// Compile-only assertions, included by `vp check`, never executed by Vitest.
import { Context, Effect, Layer } from "effect";
import { HttpRouter, HttpServer } from "effect/unstable/http";
import { ActionGroup, ActionHttp, ActionMcp } from "../src/index.js";
import { makeTestHttp, makeTestMcp } from "./http.js";
import { CurrentActor } from "../examples/auth.js";
import { Actions } from "../examples/contracts.js";
import { App } from "../examples/handlers.js";
import { Users } from "../examples/users.js";

export const typeAssertions = () => {
  const actor = { id: "alice", tenantId: "acme", permissions: [] };
  const ok = {
    getUser: ({ id }: { id: string }) => Effect.succeed({ id, name: "Ada" }),
    renameUser: ({ id, name }: { id: string; name: string }) => Effect.succeed({ id, name }),
    double: ({ value }: { value: number }) => Effect.succeed(value * 2),
    whoAmI: () => Effect.succeed({ id: "alice", tenantId: "acme" }),
  };

  const a = Actions.implement(ok);
  const b = Actions.implement(ok);
  // @ts-expect-error Implementation bindings cannot be extracted or cross-wired.
  void Effect.runPromise(a.handlers.pipe(Effect.provide(b.layer)));
  // @ts-expect-error No public implementation Layer.
  void a.layer;
  // @ts-expect-error No public handler tag.
  void a.handlers;
  // @ts-expect-error Only the opaque implementation type is public, not its constructor.
  void ActionGroup.Implementation;
  // @ts-expect-error Adapter dispatch helpers are not public API.
  void ActionGroup.handlerFor;
  // @ts-expect-error The requirement assertion is internal, not a public execution API.
  void ActionGroup.inRequestFiber;
  // @ts-expect-error Implementations cannot be fabricated from an actions tuple.
  ActionHttp.layer({ actions: Actions.actions });
  // @ts-expect-error Every action in the group needs a handler.
  Actions.implement({ ...ok, whoAmI: undefined });
  // @ts-expect-error Handler results must match the success schema.
  Actions.implement({ ...ok, double: ({ value }) => Effect.succeed(String(value)) });
  // @ts-expect-error Handlers may only fail with the declared errors.
  Actions.implement({ ...ok, double: () => Effect.fail(new Error("undeclared")) });
  Actions.implement({
    ...ok,
    // @ts-expect-error Handlers receive the decoded input, number rather than its wire string.
    double: ({ value }: { value: string }) => Effect.succeed(Number(value)),
  });
  // @ts-expect-error Input fields come from the schema.
  Actions.implement({ ...ok, getUser: ({ userId }) => Effect.succeed({ id: userId, name: "" }) });

  const services = Layer.provide(HttpServer.layerServices);
  // @ts-expect-error Build-time handler dependencies are Layer requirements.
  HttpRouter.toWebHandler(ActionHttp.layer(App).pipe(services));
  const http = HttpRouter.toWebHandler(
    ActionHttp.layer(App).pipe(Layer.provide(Users.layerMemory), services),
  );
  // @ts-expect-error Request-scoped handler dependencies must be present per request.
  void http.handler(new Request("http://localhost"), Context.empty());
  void http.handler(new Request("http://localhost"), Context.make(CurrentActor, actor));

  // MCP carries the same request requirement as HTTP; forgetting middleware is a compile error.
  const mcpLayer = ActionMcp.layer(App, { name: "t", version: "0" });
  // @ts-expect-error Build-time handler dependencies are Layer requirements.
  HttpRouter.toWebHandler(mcpLayer.pipe(services));
  const mcp = HttpRouter.toWebHandler(mcpLayer.pipe(Layer.provide(Users.layerMemory), services));
  // @ts-expect-error Request-scoped handler dependencies must be present per request.
  void mcp.handler(new Request("http://localhost/mcp"), Context.empty());
  void mcp.handler(new Request("http://localhost/mcp"), Context.make(CurrentActor, actor));

  // A startup actor is not a request actor: it does not satisfy the request requirement.
  const startup = Layer.succeed(CurrentActor, actor);
  const withStartup = HttpRouter.toWebHandler(
    ActionHttp.layer(App).pipe(Layer.provide(Users.layerMemory), Layer.provide(startup), services),
  );
  // @ts-expect-error Still required per request.
  void withStartup.handler(new Request("http://localhost"), Context.empty());

  const mcpWithStartup = HttpRouter.toWebHandler(
    mcpLayer.pipe(Layer.provide(Users.layerMemory), Layer.provide(startup), services),
  );
  // @ts-expect-error A build-only actor does not satisfy MCP request wiring either.
  void mcpWithStartup.handler(new Request("http://localhost/mcp"), Context.empty());

  const requestOnly = Actions.implement({
    ...ok,
    whoAmI: () => Effect.map(CurrentActor, ({ id, tenantId }) => ({ id, tenantId })),
  });
  // @ts-expect-error Test helpers require an explicit request Layer.
  makeTestHttp(requestOnly);
  // @ts-expect-error Test helpers must not erase missing request services.
  makeTestHttp(requestOnly, Layer.empty);
  // @ts-expect-error Test helpers require an explicit request Layer.
  makeTestMcp(requestOnly);
  // @ts-expect-error Test helpers must not erase missing request services.
  makeTestMcp(requestOnly, Layer.empty);
  makeTestHttp(requestOnly, startup);
  makeTestMcp(requestOnly, startup);

  const fallible = Actions.implement(Effect.fail("build-failed" as const).pipe(Effect.as(ok)));
  for (const routes of [
    ActionHttp.layer(fallible),
    ActionMcp.layer(fallible, { name: "test", version: "0" }),
  ]) {
    const build = Layer.build(routes.pipe(Layer.provide(HttpRouter.layer), services)).pipe(
      Effect.scoped,
    );
    // @ts-expect-error Private bindings must not erase acquisition failures.
    void (build satisfies Effect.Effect<unknown, never>);
  }
};
