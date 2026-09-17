// Compile-only assertions, included by `vp check`, never executed by Vitest.
import { Context, Effect, Layer, Schema } from "effect";
import { HttpRouter, HttpServer } from "effect/unstable/http";
import { HttpApiClient } from "effect/unstable/httpapi";
import { Action, ActionGroup, ActionHttp, ActionMcp } from "../src/index.js";
import { makeTestHttp, makeTestMcp } from "./server.js";
import { CurrentActor } from "../examples/auth.js";
import { UserActions as Actions } from "../examples/contracts.js";
import { UserApp as App } from "../examples/handlers.js";
import { Users } from "../examples/users.js";

const openapi = { openapiPath: "/openapi.json" } as const;

const Http = ActionHttp.make(Actions, { apiPath: "/api/actions" });

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
  Http.layer({ name: Actions.name, actions: Actions.actions }, openapi);
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
    Http.layer(App, openapi).pipe(services),
  );

  const http = HttpRouter.toWebHandler(
    Http.layer(App, openapi).pipe(Layer.provide(Users.layerMemory), services),
  );

  // @ts-expect-error Request-scoped handler dependencies must be present per request.
  void http.handler(new Request("http://localhost"), Context.empty());
  void http.handler(new Request("http://localhost"), Context.make(CurrentActor, actor));

  // MCP carries the same request requirement as HTTP; forgetting middleware is a compile error.
  const mcpLayer = ActionMcp.layer(App, { name: "t", version: "0", path: "/mcp" });
  // @ts-expect-error Build-time handler dependencies are Layer requirements.
  HttpRouter.toWebHandler(mcpLayer.pipe(services));
  const mcp = HttpRouter.toWebHandler(mcpLayer.pipe(Layer.provide(Users.layerMemory), services));
  // @ts-expect-error Request-scoped handler dependencies must be present per request.
  void mcp.handler(new Request("http://localhost/mcp"), Context.empty());
  void mcp.handler(new Request("http://localhost/mcp"), Context.make(CurrentActor, actor));

  // A startup actor is not a request actor: it does not satisfy the request requirement.
  const startup = Layer.succeed(CurrentActor, actor);

  const withStartup = HttpRouter.toWebHandler(
    Http.layer(App, openapi).pipe(
      Layer.provide(Users.layerMemory),
      Layer.provide(startup),
      services,
    ),
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
    Http.layer(fallible, openapi),
    ActionMcp.layer(fallible, { name: "test", version: "0", path: "/mcp" }),
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
    "test",
    Action.make("hidden", { description: "MCP only", success: Schema.String, http: false }),
    Action.make("visible", { description: "HTTP", success: Schema.Boolean }),
  );

  const selected = yield* HttpApiClient.make(
    ActionHttp.make(mixed, { apiPath: "/api/actions" }).api,
  );

  // @ts-expect-error MCP-only actions are not HTTP client methods.
  selected.test.hidden({ payload: {} });
  const visible: boolean = yield* selected.test.visible({ payload: {} });
  void visible;
});

export const policyTypes = Effect.gen(function* () {
  class PolicyFailure extends Schema.TaggedError<PolicyFailure>()("PolicyFailure", {}) {}

  const options = {
    apiPath: "/api/actions" as const,
    schemaError: { errors: [PolicyFailure], map: () => new PolicyFailure() },
  };

  const client = yield* HttpApiClient.make(ActionHttp.make(Actions, options).api);
  yield* client.users
    .double({ payload: { value: 1 } })
    .pipe(Effect.catchTag("PolicyFailure", () => Effect.succeed(0)));
  ActionHttp.make(Actions, {
    apiPath: "/api/actions",
    schemaError: {
      errors: [PolicyFailure],
      // @ts-expect-error The mapper can return only errors declared by this policy.
      map: () => "undeclared",
    },
  });
  ActionHttp.make(Actions, {
    apiPath: "/api/actions",
    schemaError: {
      errors: [PolicyFailure],
      // @ts-expect-error Policy mapping is pure, not a service-requiring Effect.
      map: () => Effect.as(CurrentActor, new PolicyFailure()),
    },
  });
});

export const configuredClientTypes = () => {
  void Effect.gen(function* () {
    class Invalid extends Schema.TaggedError<Invalid>()("Invalid", {
      phase: Schema.Literals(["input", "output"]),
    }) {}

    // The helper infers the error tuple and types `map` without an annotation.
    const schemaError = Action.schemaErrorPolicy({
      errors: [Invalid],
      map: ({ phase }) => new Invalid({ phase }),
    });

    const Bound = ActionHttp.make(Actions, { apiPath: "/rpc", schemaError });
    const client = yield* Bound.client({ baseUrl: "http://localhost" });
    // @ts-expect-error apiPath is bound by make, not a connection option.
    Bound.client({ apiPath: "/different" });
    // @ts-expect-error Schema policy is also bound by make.
    Bound.client({ schemaError });
    // @ts-expect-error OpenAPI route configuration has no client-side meaning.
    Bound.client({ baseUrl: "http://localhost", openapiPath: "/schema" });
    yield* client.double({ value: 1 }).pipe(Effect.catchTag("Invalid", () => Effect.succeed(0)));
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
      "test",
      Action.make("hidden", { description: "MCP only", success: Schema.String, http: false }),
      Action.make("optional", {
        description: "Optional input",
        input: Schema.Struct({ value: Schema.optional(Schema.Number) }),
        success: Schema.Number,
      }),
    );

    const selected = yield* ActionHttp.make(mixed, { apiPath: "/rpc", schemaError }).client();
    // @ts-expect-error MCP-only actions have no direct HTTP method.
    selected.hidden();
    yield* selected.optional();
    yield* selected.optional(undefined);
    yield* selected.optional({ value: 1 });
    // @ts-expect-error Optional inputs still have a checked shape.
    selected.optional({ value: "1" });

    const services = Layer.provide(HttpServer.layerServices);
    // @ts-expect-error A policy-bound adapter must preserve acquisition requirements.
    HttpRouter.toWebHandler(Bound.layer(App, openapi).pipe(services));

    const web = HttpRouter.toWebHandler(
      Bound.layer(App, openapi).pipe(Layer.provide(Users.layerMemory), services),
    );

    // @ts-expect-error Configuring the adapter must preserve request requirements.
    void web.handler(new Request("http://localhost"), Context.empty());
    ActionMcp.layer(App, { name: "test", version: "0", path: "/mcp", schemaError });
    ActionMcp.layer(App, {
      name: "test",
      version: "0",
      path: "/mcp",
      schemaError: {
        errors: [Invalid],
        // @ts-expect-error MCP shares the declared-error mapper constraint.
        map: () => "undeclared",
      },
    });
    // @ts-expect-error HTTP mount path is required.
    ActionHttp.make(Actions, {});
    // @ts-expect-error OpenAPI document route is required on layer.
    Bound.layer(App);
    // @ts-expect-error MCP mount path is required.
    ActionMcp.layer(App, { name: "test", version: "0" });
  });
};

export const multipleGroupTypes = () => {
  class Tenant extends Context.Service<Tenant, string>()("types/Tenant") {}

  const Billing = ActionGroup.make(
    "billing",
    Action.make("invoice", { description: "Invoice", success: Schema.Number }),
  );

  const BillingApp = Billing.implement({ invoice: () => Effect.as(Tenant, 1) });

  const Both = ActionHttp.make([Actions, Billing], { apiPath: "/api" });

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

  // Pairing is by group identity, so order is free; completeness is checked at construction.
  Both.layer([BillingApp, App], openapi);

  const Foreign = ActionGroup.make(
    "foreign",
    Action.make("other", { description: "Other", success: Schema.String }),
  ).implement({ other: () => Effect.succeed("") });

  // @ts-expect-error Implementations of other contracts are rejected.
  Both.layer([App, BillingApp, Foreign], openapi);
  // @ts-expect-error A contract is not its implementation.
  ActionHttp.make(App, { apiPath: "/api" });

  const services = Layer.provide(HttpServer.layerServices);

  for (const routes of [
    Both.layer([App, BillingApp], openapi),
    ActionMcp.layer([App, BillingApp], { name: "test", version: "0", path: "/mcp" }),
  ]) {
    const web = HttpRouter.toWebHandler(routes.pipe(Layer.provide(Users.layerMemory), services));

    // @ts-expect-error Request requirements are the union over every implementation.
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
    ActionHttp.make([Billing], { apiPath: "/api" })
      .layer([Billing.implement({ invoice: () => Effect.succeed(1) })], openapi)
      .pipe(services),
  );

  void inline.handler(new Request("http://localhost"));

  // Groups under their own middleware: the root requires each served group's route layer.
  const root = Both.groups(openapi);

  const mounted = root.pipe(
    Layer.provide(Both.group(App)),
    Layer.provide(Both.group(BillingApp)),
    Layer.provide(Users.layerMemory),
    services,
  );

  void HttpRouter.toWebHandler(mounted);
  // @ts-expect-error A served group that is never mounted is an unsatisfied requirement.
  void HttpRouter.toWebHandler(root.pipe(Layer.provide(Both.group(App)), services));
  // @ts-expect-error Merging does not provide: the root still requires its groups.
  void HttpRouter.toWebHandler(Layer.mergeAll(root, Both.group(App), Both.group(BillingApp)));
  // @ts-expect-error Route layers exist only for implementations of the bound groups.
  Both.group(Foreign);

  // A layer built from a union of implementations cannot say which group it
  // mounted, so it satisfies neither requirement.
  const either = Math.random() > 0.5 ? App : BillingApp;

  void HttpRouter.toWebHandler(
    // @ts-expect-error The union-typed group layer leaves both groups unmounted.
    root.pipe(
      Layer.provide(Both.group(either)),
      Layer.provide(Both.group(BillingApp)),
      Layer.provide(Users.layerMemory),
      services,
    ),
  );

  // The requirement names the mounted routes, so another adapter's group layer,
  // even of the same group, does not satisfy it.
  const Elsewhere = ActionHttp.make([Actions, Billing], { apiPath: "/elsewhere" });

  void HttpRouter.toWebHandler(
    // @ts-expect-error Mounted<"/elsewhere", …> is not Mounted<"/api", …>.
    root.pipe(
      Layer.provide(Elsewhere.group(App)),
      Layer.provide(Both.group(BillingApp)),
      Layer.provide(Users.layerMemory),
      services,
    ),
  );

  // Requirements are the union over what is passed; an unserved group's
  // implementation may be left out, and its requirements with it.
  const Plain = ActionGroup.make(
    "plain",
    Action.make("plain", { description: "Plain", success: Schema.String }),
  );

  const McpOnly = ActionGroup.make(
    "mcpOnly",
    Action.make("tool", { description: "Tool", success: Schema.String, http: false }),
  );

  const PlainApp = Plain.implement({ plain: () => Effect.succeed("") });
  const McpOnlyApp = McpOnly.implement({ tool: () => Effect.map(Tenant, (tenant) => tenant) });
  const Mixed = ActionHttp.make([Plain, McpOnly], { apiPath: "/api" });

  void HttpRouter.toWebHandler(Mixed.layer([PlainApp], openapi).pipe(services)).handler(
    new Request("http://localhost"),
  );

  const withUnserved = HttpRouter.toWebHandler(
    Mixed.layer([PlainApp, McpOnlyApp], openapi).pipe(services),
  );

  // @ts-expect-error Passing the unserved implementation brings its requirements along.
  void withUnserved.handler(new Request("http://localhost"));

  // @ts-expect-error Build requirements are the union over every implementation.
  HttpRouter.toWebHandler(Both.layer([App, BillingApp], openapi).pipe(services));
};
