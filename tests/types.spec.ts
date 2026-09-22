import { McpProtocol, McpSchema } from "effect/unstable/ai";
// Compile-only assertions, included by `vp check`, never executed by Vitest.
import { Context, Effect, Layer, Schema, type Stdio } from "effect";
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

interface OptionalAlias {
  readonly name?: "alias";
}

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends <Value>() => Value extends Right ? 1 : 2
    ? true
    : false;

export const typeAssertions = () => {
  const actor = { id: "alice", tenantId: "acme", permissions: [] };
  const optionalAlias: OptionalAlias = {};

  const optionallyAliased = Action.make("fallback", {
    description: "Optional alias",
    access: "write",
    success: Schema.String,
    mcp: optionalAlias,
  });

  const optionalName: "alias" | "fallback" = optionallyAliased.mcp.name;
  void optionalName;

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
  Http.layer({}, { name: Actions.name, actions: Actions.actions });
  // @ts-expect-error Spreading a nominal implementation cannot manufacture its private build state.
  // oxlint-disable-next-line typescript/no-misused-spread -- Deliberate nominal-fabrication compile-failure fixture.
  Http.layer({}, { ...a, build: Effect.succeed(ok) });
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
    Http.layer({}, App).pipe(services),
  );

  const http = HttpRouter.toWebHandler(
    Http.layer({}, App).pipe(Layer.provide(Users.layerMemory), services),
  );

  // @ts-expect-error Request-scoped handler dependencies must be present per request.
  void http.handler(new Request("http://localhost"), Context.empty());
  void http.handler(new Request("http://localhost"), Context.make(CurrentActor, actor));

  // MCP carries the same request requirement as HTTP; forgetting middleware is a compile error.
  const mcpLayer = ActionMcp.layerHttp(
    { protocols: [McpProtocol.v2026_07_28], name: "t", version: "0", path: "/mcp" },
    App,
  );

  // @ts-expect-error Build-time handler dependencies are Layer requirements.
  HttpRouter.toWebHandler(mcpLayer.pipe(services));
  const mcp = HttpRouter.toWebHandler(mcpLayer.pipe(Layer.provide(Users.layerMemory), services));
  // @ts-expect-error Request-scoped handler dependencies must be present per request.
  void mcp.handler(new Request("http://localhost/mcp"), Context.empty());
  void mcp.handler(new Request("http://localhost/mcp"), Context.make(CurrentActor, actor));

  // The native server supplies its own request context, so the stdio host owes only `Stdio`.
  const contextual = ActionGroup.make(
    { name: "contextual" },
    Action.make("client", {
      description: "Client",
      access: "write",
      success: Schema.String,
      mcp: {},
    }),
  ).implement({
    client: () =>
      Effect.map(McpSchema.McpRequestContext, (context) => context.clientInfo?.name ?? ""),
  });

  const stdio: Layer.Layer<never, unknown, Stdio.Stdio> = ActionMcp.layerStdio(
    { protocols: [McpProtocol.v2026_07_28], name: "t", version: "0" },
    contextual,
  );

  void stdio;

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
    Http.layer({}, fallible),
    ActionMcp.layerHttp(
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
    Action.make("hidden", {
      description: "MCP only",
      access: "write",
      success: Schema.String,
      http: false,
    }),
    Action.make("visible", { description: "HTTP", access: "write", success: Schema.Boolean }),
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
    kind: Schema.String,
  }) {}

  class Refused extends Schema.TaggedError<Refused>()("Refused", {}) {}

  const Echo = Action.make("echo", {
    description: "Echo",
    access: "write",
    input: Schema.Struct({ value: Schema.Finite }),
    success: Schema.Finite,
  });

  // Written inline, the policy needs no annotation: `map` is typed from `errors`.
  const Policed = ActionGroup.make(
    {
      name: "policed",
      errors: [Refused],
      schemaError: { errors: [PolicyFailure], map: ({ kind }) => new PolicyFailure({ kind }) },
    },
    Echo,
  );

  // Group-level errors join each action's own: handlers may fail with them...
  Policed.implement({ echo: () => Effect.fail(new Refused()) });
  // @ts-expect-error ...but policy errors belong to the transports, not to handlers.
  Policed.implement({ echo: () => Effect.fail(new PolicyFailure({ kind: "Body" })) });

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
        map: () => Effect.as(CurrentActor, new PolicyFailure({ kind: "Body" })),
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
  HttpRouter.toWebHandler(Bound.layer({}, App).pipe(services));

  const web = HttpRouter.toWebHandler(
    Bound.layer({}, App).pipe(Layer.provide(Users.layerMemory), services),
  );

  // @ts-expect-error Configuring the adapter must preserve request requirements.
  void web.handler(new Request("http://localhost"), Context.empty());
  ActionMcp.layerHttp(
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
  ActionMcp.layerHttp({ name: "test", version: "0", path: "/mcp" }, App);
  // @ts-expect-error At least one native protocol adapter is required.
  ActionMcp.layerHttp({ name: "test", version: "0", path: "/mcp", protocols: [] }, App);
  // @ts-expect-error MCP mount path is required.
  ActionMcp.layerHttp({ protocols: [McpProtocol.v2026_07_28], name: "test", version: "0" }, App);
};

export const multipleGroupTypes = () => {
  class Tenant extends Context.Service<Tenant, string>()("types/Tenant") {}

  class BuildA extends Context.Service<BuildA, string>()("types/BuildA") {}

  class BuildB extends Context.Service<BuildB, string>()("types/BuildB") {}

  const Billing = ActionGroup.make(
    { name: "billing" },
    Action.make("invoice", { description: "Invoice", access: "write", success: Schema.Number }),
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
    Action.make("other", { description: "Other", access: "write", success: Schema.String }),
  ).implement({ other: () => Effect.succeed("") });

  // @ts-expect-error Route layers exist only for implementations of the bound groups.
  Both.layer({}, Foreign);
  // @ts-expect-error A contract is not its implementation.
  ActionHttp.make({ apiPath: "/api" }, App);
  Both.layer({}, App, BillingApp);

  const services = Layer.provide(HttpServer.layerServices);

  const failsAfterBuildA = Billing.implement(
    Effect.fail("build-a" as const).pipe(
      Effect.tap(() => BuildA),
      Effect.as({ invoice: () => Effect.succeed(1) }),
    ),
  );

  const failsAfterBuildB = Actions.implement(
    Effect.fail("build-b" as const).pipe(
      Effect.tap(() => BuildB),
      Effect.as({
        getUser: ({ id }: { id: string }) => Effect.succeed({ id, name: "" }),
        renameUser: ({ id, name }: { id: string; name: string }) => Effect.succeed({ id, name }),
        double: ({ value }: { value: number }) => Effect.succeed(value),
        whoAmI: () => Effect.succeed({ id: "", tenantId: "" }),
      }),
    ),
  );

  const variadic = Both.layer({}, failsAfterBuildA, failsAfterBuildB);
  // @ts-expect-error Variadic mounting preserves both disjoint build-service requirements.
  HttpRouter.toWebHandler(variadic.pipe(services));

  const errorsAreExact: Equal<Layer.Error<typeof variadic>, "build-a" | "build-b"> = true;
  const hasBuildA: BuildA extends Layer.Services<typeof variadic> ? true : false = true;
  const hasBuildB: BuildB extends Layer.Services<typeof variadic> ? true : false = true;
  void errorsAreExact;
  void hasBuildA;
  void hasBuildB;
  HttpRouter.toWebHandler(
    variadic.pipe(
      Layer.provide(Layer.succeed(BuildA, "a")),
      Layer.provide(Layer.succeed(BuildB, "b")),
      services,
    ),
  );

  // Each layer carries only its own implementation's requirements.
  const billingOnly = HttpRouter.toWebHandler(Both.layer({}, BillingApp).pipe(services));
  void billingOnly.handler(new Request("http://localhost"), Context.make(Tenant, "acme"));

  const both = Context.make(Tenant, "acme").pipe(
    Context.add(CurrentActor, { id: "alice", tenantId: "acme", permissions: [] }),
  );

  // Checked per adapter: over a union of both, one's requirements would hide the other's absence.
  const mergedHttp = HttpRouter.toWebHandler(
    Layer.mergeAll(Both.layer({}, App), Both.layer({}, BillingApp)).pipe(
      Layer.provide(Users.layerMemory),
      services,
    ),
  );

  // @ts-expect-error Merged, the request requirements are the union over every implementation.
  void mergedHttp.handler(new Request("http://localhost"), Context.make(Tenant, "acme"));
  void mergedHttp.handler(new Request("http://localhost"), both);

  const mergedMcp = HttpRouter.toWebHandler(
    ActionMcp.layerHttp(
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
      .layer({}, Billing.implement({ invoice: () => Effect.succeed(1) }))
      .pipe(services),
  );

  void inline.handler(new Request("http://localhost"));

  const inlineMcp = HttpRouter.toWebHandler(
    ActionMcp.layerHttp(
      { protocols: [McpProtocol.v2026_07_28], name: "test", version: "0", path: "/mcp" },
      Billing.implement({ invoice: () => Effect.succeed(1) }),
    ).pipe(services),
  );

  void inlineMcp.handler(new Request("http://localhost"));

  HttpRouter.toWebHandler(
    // @ts-expect-error Build requirements are the union over every merged layer.
    Layer.mergeAll(Both.layer({}, App), Both.layer({}, BillingApp)).pipe(services),
  );
};

export const beforeTypes = () => {
  class Denied extends Schema.TaggedError<Denied>()("Denied", {}, { httpApiStatus: 403 }) {}

  class Unrelated extends Schema.TaggedError<Unrelated>()("Unrelated", {}) {}

  class Clock extends Context.Service<Clock, number>()("types-spec/Clock") {}

  const Read = Action.make("read", {
    description: "Read",
    access: "read",
    success: Schema.String,
  });

  const Guarded = ActionGroup.make({ name: "guarded" }, Read);

  const app = Guarded.implement({ read: () => Effect.succeed("ok") });

  const binding = ActionHttp.make({ apiPath: "/api", errors: [Denied] }, Guarded);

  // The hook may fail with the surface errors the binding declares on every endpoint.
  binding.layer({ before: () => Effect.fail(new Denied()) }, app);

  // @ts-expect-error A hook may not fail with an error the surface does not declare.
  binding.layer({ before: () => Effect.fail(new Unrelated()) }, app);

  const bare = ActionHttp.make({ apiPath: "/api" }, Guarded);
  // @ts-expect-error A binding without declared errors has no failure for a hook to use.
  bare.layer({ before: () => Effect.fail(new Denied()) }, app);

  // The hook reads the contract it is about to run, including its access.
  binding.layer(
    { before: (action) => (action.access === "read" ? Effect.void : Effect.fail(new Denied())) },
    app,
  );

  // Hook services are request-time requirements, exactly like a handler's.
  const timed = HttpRouter.toWebHandler(
    binding
      .layer({ before: () => Effect.asVoid(Clock) }, app)
      .pipe(Layer.provide(HttpServer.layerServices)),
  );

  // @ts-expect-error The hook's services must be supplied per request, not erased.
  void timed.handler(new Request("http://localhost"), Context.empty());
  void timed.handler(new Request("http://localhost"), Context.make(Clock, 0));

  // MCP types its hook the same way, from the errors that endpoint declares.
  const stdio = ActionMcp.layerStdio(
    {
      protocols: [McpProtocol.v2026_07_28],
      name: "t",
      version: "0",
      errors: [Denied],
      before: () => Effect.asVoid(Clock),
    },
    app,
  );

  // The hook's services join what the stdio host owes, since nothing else supplies them.
  stdio satisfies Layer.Layer<never, unknown, Stdio.Stdio | Clock>;

  ActionMcp.layerStdio(
    {
      protocols: [McpProtocol.v2026_07_28],
      name: "t",
      version: "0",
      errors: [Denied],
      // @ts-expect-error An MCP hook may not fail with an error the endpoint does not declare.
      before: () => Effect.fail(new Unrelated()),
    },
    app,
  );
};

export const surfaceErrorTypes = Effect.gen(function* () {
  class Unauthenticated extends Schema.TaggedError<Unauthenticated>()(
    "Unauthenticated",
    {},
    { httpApiStatus: 401 },
  ) {}

  const Read = Action.make("read", { description: "Read", access: "read", success: Schema.String });

  const Surface = ActionGroup.make({ name: "surface" }, Read);

  const guarded = yield* HttpApiClient.make(
    ActionHttp.make({ apiPath: "/api", errors: [Unauthenticated] }, Surface).api,
  );

  // A failure the surface renders around every endpoint is a typed client failure.
  yield* guarded.surface
    .read({ payload: {} })
    .pipe(Effect.catchTag("Unauthenticated", () => Effect.succeed("")));

  const bare = yield* HttpApiClient.make(ActionHttp.make({ apiPath: "/api" }, Surface).api);

  yield* bare.surface
    .read({ payload: {} })
    // @ts-expect-error Undeclared, so the client has no such failure to catch.
    .pipe(Effect.catchTag("Unauthenticated", () => Effect.succeed("")));
});

export const servedRequirementTypes = () => {
  class Principal extends Context.Service<Principal, string>()("types-spec/Principal") {}

  class HiddenBuild extends Context.Service<HiddenBuild, string>()("types-spec/HiddenBuild") {}

  // A mixed group: the hidden action is the only one that needs request identity.
  const Mixed = ActionGroup.make(
    { name: "mixed" },
    Action.make("public", { description: "Public", access: "read", success: Schema.String }),
    Action.make("hidden", {
      description: "Hidden from both transports",
      access: "write",
      success: Schema.String,
      http: false,
      mcp: false,
    }),
  ).implement({
    public: () => Effect.succeed("public"),
    hidden: () => Effect.map(Principal, (principal) => principal),
  });

  const services = Layer.provide(HttpServer.layerServices);

  const http = HttpRouter.toWebHandler(
    ActionHttp.make({ apiPath: "/api" }, Mixed.group).layer({}, Mixed).pipe(services),
  );

  // No served HTTP action needs `Principal`, so no request owes it.
  void http.handler(new Request("http://localhost"), Context.empty());

  const mcp = HttpRouter.toWebHandler(
    ActionMcp.layerHttp(
      { protocols: [McpProtocol.v2026_07_28], name: "t", version: "0", path: "/mcp" },
      Mixed,
    ).pipe(services),
  );

  void mcp.handler(new Request("http://localhost/mcp"), Context.empty());

  // A group with nothing to serve is never acquired, so its build channel is absent.
  const LocalOnly = ActionGroup.make(
    { name: "local" },
    Action.make("only", {
      description: "CLI only",
      access: "write",
      success: Schema.String,
      http: false,
      mcp: false,
    }),
  ).implement(
    Effect.fail("build" as const).pipe(
      Effect.tap(() => HiddenBuild),
      Effect.as({ only: () => Effect.succeed("") }),
    ),
  );

  const nothing = ActionHttp.make({ apiPath: "/api" }, LocalOnly.group).layer({}, LocalOnly);
  const noBuildError: Equal<Layer.Error<typeof nothing>, never> = true;
  const noBuildService: HiddenBuild extends Layer.Services<typeof nothing> ? false : true = true;
  void noBuildError;
  void noBuildService;
  void HttpRouter.toWebHandler(nothing.pipe(services)).handler(new Request("http://localhost"));

  // A flag decided at runtime may serve the action, so its requirements remain.
  const enabled: boolean = process.env["ENABLE"] !== "no";

  const Runtime = ActionGroup.make(
    { name: "runtime" },
    Action.make("maybe", {
      description: "Served when enabled",
      access: "read",
      success: Schema.String,
      http: enabled,
      mcp: enabled ? {} : false,
    }),
  ).implement(Effect.map(HiddenBuild, () => ({ maybe: () => Effect.map(Principal, (p) => p) })));

  const maybe = ActionHttp.make({ apiPath: "/api" }, Runtime.group).layer({}, Runtime);
  const buildKept: HiddenBuild extends Layer.Services<typeof maybe> ? true : false = true;
  void buildKept;

  const request: Principal extends Layer.Services<typeof maybe> ? "build" : "request" = "request";
  void request;

  const maybeHttp = HttpRouter.toWebHandler(
    maybe.pipe(services, Layer.provide(Layer.succeed(HiddenBuild)("built"))),
  );

  // @ts-expect-error `Principal` may be owed at request time.
  void maybeHttp.handler(new Request("http://localhost"), Context.empty());

  const maybeMcp = ActionMcp.layerHttp(
    { protocols: [McpProtocol.v2026_07_28], name: "t", version: "0", path: "/mcp" },
    Runtime,
  );

  const mcpBuildKept: HiddenBuild extends Layer.Services<typeof maybeMcp> ? true : false = true;
  void mcpBuildKept;
};
