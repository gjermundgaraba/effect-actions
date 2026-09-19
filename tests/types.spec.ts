import { McpProtocol } from "effect/unstable/ai";
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
  // oxlint-disable-next-line typescript/no-unsafe-member-access, typescript/no-unsafe-call, typescript/no-unsafe-argument -- Compile-failure fixture: the rejected access yields an error type; nothing runs.
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
  // oxlint-disable-next-line typescript/no-unsafe-assignment -- Compile-failure fixture: the rejected field yields an error type; nothing runs.
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
  const mcpLayer = ActionMcp.layer(
    { protocols: [McpProtocol.v2026_07_28], name: "t", version: "0", path: "/mcp" },
    App,
  );

  // @ts-expect-error Build-time handler dependencies are Layer requirements.
  HttpRouter.toWebHandler(mcpLayer.pipe(services));
  const mcp = HttpRouter.toWebHandler(mcpLayer.pipe(Layer.provide(Users.layerMemory), services));
  // @ts-expect-error Request-scoped handler dependencies must be present per request.
  void mcp.handler(new Request("http://localhost/mcp"), Context.empty());
  void mcp.handler(new Request("http://localhost/mcp"), Context.make(CurrentActor, actor));

  const requestActor = Layer.succeed(CurrentActor, actor);

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
  makeTestHttp(requestOnly, requestActor);
  makeTestMcp(requestOnly, requestActor);

  const fallible = Actions.implement(Effect.fail("build-failed" as const).pipe(Effect.as(ok)));

  for (const routes of [
    Http.layer(fallible),
    ActionMcp.layer(
      { protocols: [McpProtocol.v2026_07_28], name: "test", version: "0", path: "/mcp" },
      fallible,
    ),
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
  // @ts-expect-error Native payloads are explicit, even for no-input actions.
  client.users.whoAmI();
  // @ts-expect-error Native methods require the payload wrapper.
  client.users.double({ value: 21 });
  // @ts-expect-error No-input actions reject invented fields.
  client.users.whoAmI({ payload: { actor: "alice" } });

  // @ts-expect-error Action names are exact.
  // oxlint-disable-next-line typescript/no-unsafe-call -- Compile-failure fixture: the rejected method yields an error type; nothing runs.
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
  // oxlint-disable-next-line typescript/no-unsafe-call -- Compile-failure fixture: the rejected method yields an error type; nothing runs.
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

  // Both domain and policy errors reach the native client.
  const bound = ActionHttp.make({ apiPath: "/api/actions" }, Policed);
  const native = yield* HttpApiClient.make(bound.api);
  yield* native.policed.echo({ payload: { value: 1 } }).pipe(
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

export const configuredAdapterTypes = () => {
  const Bound = ActionHttp.make({ apiPath: "/rpc" }, Actions);
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
      protocols: [McpProtocol.v2026_07_28],
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
  // @ts-expect-error Protocol selection is required.
  ActionMcp.layer({ name: "test", version: "0", path: "/mcp" }, App);
  // @ts-expect-error At least one native protocol adapter is required.
  ActionMcp.layer({ name: "test", version: "0", path: "/mcp", protocols: [] }, App);
  // @ts-expect-error MCP mount path is required.
  ActionMcp.layer({ protocols: [McpProtocol.v2026_07_28], name: "test", version: "0" }, App);
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
    // The native client retains group namespaces.
    const client = yield* HttpApiClient.make(Both.api);
    const total: number = yield* client.billing.invoice({ payload: {} });
    void total;
    yield* client.users.whoAmI({ payload: {} });
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

  const both = Context.make(Tenant, "acme").pipe(
    Context.add(CurrentActor, { id: "alice", tenantId: "acme", permissions: [] }),
  );

  // Checked per adapter: over a union of both, one's requirements would hide the other's absence.
  const mergedHttp = HttpRouter.toWebHandler(
    Layer.mergeAll(Both.layer(App), Both.layer(BillingApp)).pipe(
      Layer.provide(Users.layerMemory),
      services,
    ),
  );

  // @ts-expect-error Merged, the request requirements are the union over every implementation.
  void mergedHttp.handler(new Request("http://localhost"), Context.make(Tenant, "acme"));
  void mergedHttp.handler(new Request("http://localhost"), both);

  const mergedMcp = HttpRouter.toWebHandler(
    ActionMcp.layer(
      { protocols: [McpProtocol.v2026_07_28], name: "test", version: "0", path: "/mcp" },
      App,
      BillingApp,
    ).pipe(Layer.provide(Users.layerMemory), services),
  );

  // @ts-expect-error One endpoint requires the union over every implementation it serves.
  void mergedMcp.handler(new Request("http://localhost"), Context.make(Tenant, "acme"));
  void mergedMcp.handler(new Request("http://localhost"), both);

  // Implementing inline must not let the adapter's parameter type erase requirements.
  const inline = HttpRouter.toWebHandler(
    ActionHttp.make({ apiPath: "/api" }, Billing)
      .layer(Billing.implement({ invoice: () => Effect.succeed(1) }))
      .pipe(services),
  );

  void inline.handler(new Request("http://localhost"));

  const inlineMcp = HttpRouter.toWebHandler(
    ActionMcp.layer(
      { protocols: [McpProtocol.v2026_07_28], name: "test", version: "0", path: "/mcp" },
      Billing.implement({ invoice: () => Effect.succeed(1) }),
    ).pipe(services),
  );

  void inlineMcp.handler(new Request("http://localhost"));

  // @ts-expect-error Build requirements are the union over every merged layer.
  HttpRouter.toWebHandler(Layer.mergeAll(Both.layer(App), Both.layer(BillingApp)).pipe(services));
};
