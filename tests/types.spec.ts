// Compile-only assertions, included by `vp check`, never executed by Vitest.
import { Context, Effect, Layer, Schema } from "effect";
import { HttpRouter, HttpServer } from "effect/unstable/http";
import { HttpApiClient } from "effect/unstable/httpapi";
import * as Action from "../src/Action.js";
import * as ActionGroup from "../src/ActionGroup.js";
import * as ActionHttp from "../src/ActionHttp.js";
import * as ActionMcp from "../src/ActionMcp.js";
import { makeTestHttp, makeTestMcp } from "./server.js";
import { CurrentActor } from "../examples/auth.js";
import { UserActions as Actions } from "../examples/contracts.js";
import { UserApp as App } from "../examples/handlers.js";
import { Users } from "../examples/users.js";

const Http = ActionHttp.make({ apiPath: "/api/actions" }, Actions);

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
  // @ts-expect-error Implementations cannot be fabricated from a group.
  Http.layer({ name: Actions.name, actions: Actions.actions });
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
  HttpRouter.toWebHandler(
    // @ts-expect-error Build-time handler dependencies are Layer requirements.
    Http.layer(App).pipe(services),
  );

  const http = HttpRouter.toWebHandler(
    Http.layer(App).pipe(Layer.provide(Users.layerMemory), services),
  );

  // @ts-expect-error Request-scoped handler dependencies must be present per request.
  void http.handler(new Request("http://localhost"), Context.empty());
  void http.handler(new Request("http://localhost"), Context.make(CurrentActor, actor));

  // MCP carries the same request requirement as HTTP; forgetting middleware is a compile error.
  const mcpLayer = ActionMcp.layer({ name: "t", version: "0", path: "/mcp" }, App);
  // @ts-expect-error Build-time handler dependencies are Layer requirements.
  HttpRouter.toWebHandler(mcpLayer.pipe(services));
  const mcp = HttpRouter.toWebHandler(mcpLayer.pipe(Layer.provide(Users.layerMemory), services));
  // @ts-expect-error Request-scoped handler dependencies must be present per request.
  void mcp.handler(new Request("http://localhost/mcp"), Context.empty());
  void mcp.handler(new Request("http://localhost/mcp"), Context.make(CurrentActor, actor));

  // A startup actor is not a request actor: it does not satisfy the request requirement.
  const startup = Layer.succeed(CurrentActor, actor);

  const withStartup = HttpRouter.toWebHandler(
    Http.layer(App).pipe(Layer.provide(Users.layerMemory), Layer.provide(startup), services),
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
    Http.layer(fallible),
    ActionMcp.layer({ name: "test", version: "0", path: "/mcp" }, fallible),
  ]) {
    const build = Layer.build(routes.pipe(Layer.provide(HttpRouter.layer), services)).pipe(
      Effect.scoped,
    );

    // @ts-expect-error Private bindings must not erase acquisition failures.
    void (build satisfies Effect.Effect<unknown, never>);
  }
};

export const clientTypes = Effect.gen(function* () {
  const client = yield* HttpApiClient.make(Http.api);
  const doubled: number = yield* client.users.double({ payload: { value: 21 } });
  void doubled;
  // @ts-expect-error Action names are exact.
  client.users.missing({ payload: {} });
  // @ts-expect-error Clients take decoded, not wire, inputs.
  client.users.double({ payload: { value: "21" } });
  // @ts-expect-error Results retain the success type.
  const wrong: string = yield* client.users.double({ payload: { value: 21 } });
  void wrong;

  const mixed = ActionGroup.make(
    { name: "test" },
    Action.make("hidden", { description: "MCP only", success: Schema.String, http: false }),
    Action.make("visible", { description: "HTTP", success: Schema.Boolean }),
  );

  const selected = yield* HttpApiClient.make(
    ActionHttp.make({ apiPath: "/api/actions" }, mixed).api,
  );

  // @ts-expect-error MCP-only actions are not HTTP client methods.
  selected.test.hidden({ payload: {} });
  const visible: boolean = yield* selected.test.visible({ payload: {} });
  void visible;
});

export const policyTypes = Effect.gen(function* () {
  class PolicyFailure extends Schema.TaggedError<PolicyFailure>()("PolicyFailure", {
    phase: Schema.Literals(["input", "output"]),
  }) {}

  class Refused extends Schema.TaggedError<Refused>()("Refused", {}) {}

  const Echo = Action.make("echo", {
    description: "Echo",
    input: Schema.Struct({ value: Schema.Finite }),
    success: Schema.Finite,
  });

  // Written inline, the policy needs no annotation: `map` is typed from `errors`.
  const Policed = ActionGroup.make(
    {
      name: "policed",
      errors: [Refused],
      schemaError: { errors: [PolicyFailure], map: ({ phase }) => new PolicyFailure({ phase }) },
    },
    Echo,
  );

  // Group-level errors join each action's own: handlers may fail with them...
  Policed.implement({ echo: () => Effect.fail(new Refused()) });
  // @ts-expect-error ...but policy errors belong to the transports, not to handlers.
  Policed.implement({ echo: () => Effect.fail(new PolicyFailure({ phase: "input" })) });

  // Both reach clients, native and direct.
  const bound = ActionHttp.make({ apiPath: "/api/actions" }, Policed);
  const native = yield* HttpApiClient.make(bound.api);
  yield* native.policed.echo({ payload: { value: 1 } }).pipe(
    Effect.catchTag("PolicyFailure", () => Effect.succeed(0)),
    Effect.catchTag("Refused", () => Effect.succeed(0)),
  );
  const direct = yield* bound.client();
  yield* direct.echo({ value: 1 }).pipe(
    Effect.catchTag("PolicyFailure", () => Effect.succeed(0)),
    Effect.catchTag("Refused", () => Effect.succeed(0)),
  );

  ActionGroup.make(
    {
      name: "undeclared",
      schemaError: {
        errors: [PolicyFailure],
        // @ts-expect-error The mapper can return only errors declared by this policy.
        map: () => "undeclared",
      },
    },
    Echo,
  );
  ActionGroup.make(
    {
      name: "effectful",
      schemaError: {
        errors: [PolicyFailure],
        // @ts-expect-error Policy mapping is pure, not a service-requiring Effect.
        map: () => Effect.as(CurrentActor, new PolicyFailure({ phase: "input" })),
      },
    },
    Echo,
  );
  // @ts-expect-error The policy is the group's; adapters no longer take one.
  ActionHttp.make({ apiPath: "/api/actions", schemaError: Policed.schemaError }, Policed);
});

export const configuredClientTypes = () => {
  void Effect.gen(function* () {
    const Bound = ActionHttp.make({ apiPath: "/rpc" }, Actions);
    const client = yield* Bound.client({ baseUrl: "http://localhost" });
    // @ts-expect-error apiPath is bound by make, not a connection option.
    Bound.client({ apiPath: "/different" });
    // @ts-expect-error The schema-error policy is the group's, not a connection option.
    Bound.client({ schemaError: Actions.schemaError });
    // @ts-expect-error OpenAPI route configuration has no client-side meaning.
    Bound.client({ baseUrl: "http://localhost", openapiPath: "/schema" });
    yield* client
      .double({ value: 1 })
      .pipe(Effect.catchTag("InvalidRequest", () => Effect.succeed(0)));
    const doubled: number = yield* client.double({ value: 21 });
    void doubled;
    const identity: { readonly id: string; readonly tenantId: string } = yield* client.whoAmI();
    void identity;
    yield* client.getUser({ id: "1" }).pipe(
      Effect.catchTag("UserNotFound", () => Effect.succeed(null)),
      Effect.catchTag("InvalidRequest", () => Effect.succeed(null)),
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
      { name: "test" },
      Action.make("hidden", { description: "MCP only", success: Schema.String, http: false }),
      Action.make("optional", {
        description: "Optional input",
        input: Schema.Struct({ value: Schema.optional(Schema.Number) }),
        success: Schema.Number,
      }),
    );

    const selected = yield* ActionHttp.make({ apiPath: "/rpc" }, mixed).client();
    // @ts-expect-error MCP-only actions have no direct HTTP method.
    selected.hidden();
    yield* selected.optional();
    yield* selected.optional(undefined);
    yield* selected.optional({ value: 1 });
    // @ts-expect-error Optional inputs still have a checked shape.
    selected.optional({ value: "1" });

    const services = Layer.provide(HttpServer.layerServices);
    // @ts-expect-error A policy-bound adapter must preserve acquisition requirements.
    HttpRouter.toWebHandler(Bound.layer(App).pipe(services));

    const web = HttpRouter.toWebHandler(
      Bound.layer(App).pipe(Layer.provide(Users.layerMemory), services),
    );

    // @ts-expect-error Configuring the adapter must preserve request requirements.
    void web.handler(new Request("http://localhost"), Context.empty());
    ActionMcp.layer(
      {
        name: "test",
        version: "0",
        path: "/mcp",
        // @ts-expect-error The policy is the group's; adapters no longer take one.
        schemaError: Actions.schemaError,
      },
      App,
    );
    // @ts-expect-error HTTP mount path is required.
    ActionHttp.make({}, Actions);
    // @ts-expect-error MCP mount path is required.
    ActionMcp.layer({ name: "test", version: "0" }, App);
  });
};

export const multipleGroupTypes = () => {
  class Tenant extends Context.Service<Tenant, string>()("types/Tenant") {}

  const Billing = ActionGroup.make(
    { name: "billing" },
    Action.make("invoice", { description: "Invoice", success: Schema.Number }),
  );

  const BillingApp = Billing.implement({ invoice: () => Effect.as(Tenant, 1) });

  const Both = ActionHttp.make({ apiPath: "/api" }, Actions, Billing);

  // One native group per action group, keyed by its name.
  void Both.api.groups.users.endpoints.double;
  void Both.api.groups.billing.endpoints.invoice;

  void Effect.gen(function* () {
    // The direct client stays flat across groups.
    const client = yield* Both.client();
    const total: number = yield* client.invoice();
    void total;
    yield* client.whoAmI();
  });

  const Foreign = ActionGroup.make(
    { name: "foreign" },
    Action.make("other", { description: "Other", success: Schema.String }),
  ).implement({ other: () => Effect.succeed("") });

  // @ts-expect-error Route layers exist only for implementations of the bound groups.
  Both.layer(Foreign);
  // @ts-expect-error A contract is not its implementation.
  ActionHttp.make({ apiPath: "/api" }, App);
  // @ts-expect-error One layer mounts one group; merge one per group.
  Both.layer(App, BillingApp);

  const services = Layer.provide(HttpServer.layerServices);

  // Each layer carries only its own implementation's requirements.
  const billingOnly = HttpRouter.toWebHandler(Both.layer(BillingApp).pipe(services));
  void billingOnly.handler(new Request("http://localhost"), Context.make(Tenant, "acme"));

  for (const routes of [
    Layer.mergeAll(Both.layer(App), Both.layer(BillingApp)),
    ActionMcp.layer({ name: "test", version: "0", path: "/mcp" }, App, BillingApp),
  ]) {
    const web = HttpRouter.toWebHandler(routes.pipe(Layer.provide(Users.layerMemory), services));

    // @ts-expect-error Merged, the request requirements are the union over every implementation.
    void web.handler(new Request("http://localhost"), Context.make(Tenant, "acme"));
    void web.handler(
      new Request("http://localhost"),
      Context.make(Tenant, "acme").pipe(
        Context.add(CurrentActor, { id: "alice", tenantId: "acme", permissions: [] }),
      ),
    );
  }

  // Implementing inline must not let the adapter's parameter type erase requirements.
  const inline = HttpRouter.toWebHandler(
    ActionHttp.make({ apiPath: "/api" }, Billing)
      .layer(Billing.implement({ invoice: () => Effect.succeed(1) }))
      .pipe(services),
  );

  void inline.handler(new Request("http://localhost"));

  const inlineMcp = HttpRouter.toWebHandler(
    ActionMcp.layer(
      { name: "test", version: "0", path: "/mcp" },
      Billing.implement({ invoice: () => Effect.succeed(1) }),
    ).pipe(services),
  );

  void inlineMcp.handler(new Request("http://localhost"));

  // @ts-expect-error Build requirements are the union over every merged layer.
  HttpRouter.toWebHandler(Layer.mergeAll(Both.layer(App), Both.layer(BillingApp)).pipe(services));
};
