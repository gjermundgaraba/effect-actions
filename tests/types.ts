// Compile-only assertions, included by `vp check`, never executed by Vitest.
import { Context, Effect, Layer, Schema } from "effect";
import { HttpRouter, HttpServer } from "effect/unstable/http";
import { HttpApiClient } from "effect/unstable/httpapi";
import { Action, ActionGroup, ActionHttp, ActionMcp } from "../src/index.js";
import { makeTestHttp, makeTestMcp } from "./server.js";
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

export const clientTypes = Effect.gen(function* () {
  const client = yield* HttpApiClient.make(ActionHttp.api(Actions));
  const doubled: number = yield* client.actions.double({ payload: { value: 21 } });
  void doubled;
  // @ts-expect-error Action names are exact.
  client.actions.missing({ payload: {} });
  // @ts-expect-error Clients take decoded, not wire, inputs.
  client.actions.double({ payload: { value: "21" } });
  // @ts-expect-error Results retain the success type.
  const wrong: string = yield* client.actions.double({ payload: { value: 21 } });
  void wrong;
  const mixed = ActionGroup.make(
    Action.make("hidden", { description: "MCP only", success: Schema.String, http: false }),
    Action.make("visible", { description: "HTTP", success: Schema.Boolean }),
  );
  const selected = yield* HttpApiClient.make(ActionHttp.api(mixed));
  // @ts-expect-error MCP-only actions are not HTTP client methods.
  selected.actions.hidden({ payload: {} });
  const visible: boolean = yield* selected.actions.visible({ payload: {} });
  void visible;
});

export const policyTypes = Effect.gen(function* () {
  class PolicyFailure extends Schema.TaggedError<PolicyFailure>()("PolicyFailure", {}) {}
  const options = { schemaError: { errors: [PolicyFailure], map: () => new PolicyFailure() } };
  const client = yield* HttpApiClient.make(ActionHttp.api(Actions, options));
  yield* client.actions
    .double({ payload: { value: 1 } })
    .pipe(Effect.catchTag("PolicyFailure", () => Effect.succeed(0)));
  ActionHttp.api(Actions, {
    schemaError: {
      errors: [PolicyFailure],
      // @ts-expect-error The mapper can return only errors declared by this policy.
      map: () => "undeclared",
    },
  });
  ActionHttp.api(Actions, {
    schemaError: {
      errors: [PolicyFailure],
      // @ts-expect-error Policy mapping is pure, not a service-requiring Effect.
      map: () => Effect.as(CurrentActor, new PolicyFailure()),
    },
  });
});

export const configuredClientTypes = () => {
  void Effect.gen(function* () {
    class Invalid extends Schema.TaggedError<Invalid>()("Invalid", {}) {}
    const schemaError = {
      errors: [Invalid],
      map: (_failure: Action.SchemaFailure) => new Invalid(),
    };
    const Http = ActionHttp.configure({ prefix: "/rpc", schemaError });
    const client = yield* Http.client(Actions);
    // @ts-expect-error Prefix is bound by configure, not a connection option.
    Http.client(Actions, { prefix: "/different" });
    // @ts-expect-error Schema policy is also bound by configure.
    Http.client(Actions, { schemaError });
    // @ts-expect-error OpenAPI route configuration has no client-side meaning.
    ActionHttp.client(Actions, { baseUrl: "http://localhost", openapiPath: "/schema" });
    yield* (yield* ActionHttp.client(Actions, {
      baseUrl: "http://localhost",
      prefix: "/rpc",
      schemaError,
    }))
      .double({ value: 1 })
      .pipe(Effect.catchTag("Invalid", () => Effect.succeed(0)));
    const doubled: number = yield* client.double({ value: 21 });
    void doubled;
    const identity: { readonly id: string; readonly tenantId: string } = yield* client.whoAmI();
    void identity;
    yield* client.getUser({ id: "1" }).pipe(
      Effect.catchTag("UserNotFound", () => Effect.succeed(null)),
      Effect.catchTag("Invalid", () => Effect.succeed(null)),
    );
    // @ts-expect-error No HTTP wrapper objects on direct action calls.
    client.double({ payload: { value: 21 } });
    // @ts-expect-error Required input cannot be omitted.
    client.double();
    // @ts-expect-error Input is decoded, not its string wire representation.
    client.double({ value: "21" });
    // @ts-expect-error The output is not erased to unknown or any.
    const wrong: string = yield* client.double({ value: 21 });
    void wrong;
    // @ts-expect-error No-input actions do not accept invented input fields.
    client.whoAmI({ actor: "alice" });
    // @ts-expect-error Names remain exact.
    client.missing();

    const mixed = ActionGroup.make(
      Action.make("hidden", { description: "MCP only", success: Schema.String, http: false }),
      Action.make("optional", {
        description: "Optional input",
        input: Schema.Struct({ value: Schema.optional(Schema.Number) }),
        success: Schema.Number,
      }),
    );
    const selected = yield* ActionHttp.client(mixed, { prefix: "/rpc", schemaError });
    // @ts-expect-error Standalone clients preserve required input as well.
    (yield* ActionHttp.client(Actions)).double();
    yield* (yield* ActionHttp.client(Actions, { schemaError }))
      .double({ value: 1 })
      .pipe(Effect.catchTag("Invalid", () => Effect.succeed(0)));
    // @ts-expect-error MCP-only actions have no direct HTTP method.
    selected.hidden();
    yield* selected.optional();
    yield* selected.optional(undefined);
    yield* selected.optional({ value: 1 });
    // @ts-expect-error Optional inputs still have a checked shape.
    selected.optional({ value: "1" });

    const services = Layer.provide(HttpServer.layerServices);
    // @ts-expect-error Configuring the adapter must preserve acquisition requirements.
    HttpRouter.toWebHandler(Http.layer(App).pipe(services));
    const web = HttpRouter.toWebHandler(
      Http.layer(App).pipe(Layer.provide(Users.layerMemory), services),
    );
    // @ts-expect-error Configuring the adapter must preserve request requirements.
    void web.handler(new Request("http://localhost"), Context.empty());
    ActionMcp.layer(App, { name: "test", version: "0", schemaError });
    ActionMcp.layer(App, {
      name: "test",
      version: "0",
      schemaError: {
        errors: [Invalid],
        // @ts-expect-error MCP shares the declared-error mapper constraint.
        map: () => "undeclared",
      },
    });
  });
};
