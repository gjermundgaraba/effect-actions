import { McpProtocol, McpSchema, Tool } from "effect/unstable/ai";
// Compile-only assertions, included by `vp check`, never executed by Vitest.
import { Context, Effect, Layer, Schema, type Stdio } from "effect";
import { HttpRouter, HttpServer } from "effect/unstable/http";
import { HttpApiClient } from "effect/unstable/httpapi";
import * as Action from "../src/Action.js";
import * as ActionGroup from "../src/ActionGroup.js";
import * as ActionHttp from "../src/ActionHttp.js";
import * as ActionMcp from "../src/ActionMcp.js";
import * as ActionToolkit from "../src/ActionToolkit.js";
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
  Http.layer([{ name: Actions.name, actions: Actions.actions }]);
  // @ts-expect-error Spreading a nominal implementation cannot manufacture its private build state.
  // oxlint-disable-next-line typescript/no-misused-spread -- Deliberate nominal-fabrication compile-failure fixture.
  Http.layer([{ ...a, build: Effect.succeed(ok) }]);
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
    Http.layer([App]).pipe(services),
  );

  const http = HttpRouter.toWebHandler(
    Http.layer([App]).pipe(Layer.provide(Users.layerMemory), services),
  );

  // @ts-expect-error Request-scoped handler dependencies must be present per request.
  void http.handler(new Request("http://localhost"), Context.empty());
  void http.handler(new Request("http://localhost"), Context.make(CurrentActor, actor));

  // MCP carries the same request requirement as HTTP; forgetting middleware is a compile error.
  const mcpLayer = ActionMcp.layerHttp([App], {
    name: "t",
    version: "0",
    path: "/mcp",
  });

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

  const stdio: Layer.Layer<never, unknown, Stdio.Stdio> = ActionMcp.layerStdio([contextual], {
    name: "t",
    version: "0",
  });

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
    Http.layer([fallible]),
    ActionMcp.layerHttp([fallible], {
      name: "test",
      version: "0",
      path: "/mcp",
    }),
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

  // Written inline, the policy needs no annotation: each `make` is typed from its `schema`.
  const Policed = ActionGroup.make(
    {
      name: "policed",
      errors: [Refused],
      schemaError: {
        invalid: { schema: PolicyFailure, make: ({ kind }) => new PolicyFailure({ kind }) },
        internal: { schema: PolicyFailure, make: ({ kind }) => new PolicyFailure({ kind }) },
      },
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
        // @ts-expect-error An answer can return only its own declared error.
        invalid: { schema: PolicyFailure, make: () => "undeclared" },
        internal: { schema: PolicyFailure, make: () => new PolicyFailure({ kind: "Body" }) },
      },
    },
    Echo,
  );
  ActionGroup.make(
    {
      name: "effectful",
      schemaError: {
        invalid: { schema: PolicyFailure, make: () => new PolicyFailure({ kind: "Payload" }) },
        internal: {
          schema: PolicyFailure,
          // @ts-expect-error An answer is pure, not a service-requiring Effect.
          make: () => Effect.as(CurrentActor, new PolicyFailure({ kind: "Body" })),
        },
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
  HttpRouter.toWebHandler(Bound.layer([App]).pipe(services));

  const web = HttpRouter.toWebHandler(
    Bound.layer([App]).pipe(Layer.provide(Users.layerMemory), services),
  );

  // @ts-expect-error Configuring the adapter must preserve request requirements.
  void web.handler(new Request("http://localhost"), Context.empty());
  ActionMcp.layerHttp([App], {
    name: "test",
    version: "0",
    path: "/mcp",
    // @ts-expect-error The policy is the group's; adapters no longer take one.
    schemaError: Actions.schemaError,
  });
  // @ts-expect-error HTTP mount path is required.
  ActionHttp.make({}, Actions);
  ActionMcp.layerHttp([App], {
    name: "test",
    version: "0",
    path: "/mcp",
    // @ts-expect-error The protocol revision is fixed at 2026-07-28.
    protocols: [McpProtocol.v2026_07_28],
  });
  ActionMcp.layerStdio([App], {
    name: "test",
    version: "0",
    // @ts-expect-error The protocol revision is fixed at 2026-07-28.
    protocols: [McpProtocol.v2026_07_28],
  });
  // @ts-expect-error MCP mount path is required.
  ActionMcp.layerHttp([App], { name: "test", version: "0" });
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
  Both.layer([Foreign]);
  // @ts-expect-error A contract is not its implementation.
  ActionHttp.make({ apiPath: "/api" }, App);
  Both.layer([App, BillingApp]);

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

  const combined = Both.layer([failsAfterBuildA, failsAfterBuildB]);
  // @ts-expect-error Variadic mounting preserves both disjoint build-service requirements.
  HttpRouter.toWebHandler(combined.pipe(services));

  const errorsAreExact: Equal<Layer.Error<typeof combined>, "build-a" | "build-b"> = true;
  const hasBuildA: BuildA extends Layer.Services<typeof combined> ? true : false = true;
  const hasBuildB: BuildB extends Layer.Services<typeof combined> ? true : false = true;
  void errorsAreExact;
  void hasBuildA;
  void hasBuildB;
  HttpRouter.toWebHandler(
    combined.pipe(
      Layer.provide(Layer.succeed(BuildA, "a")),
      Layer.provide(Layer.succeed(BuildB, "b")),
      services,
    ),
  );

  // Each layer carries only its own implementation's requirements.
  const billingOnly = HttpRouter.toWebHandler(Both.layer([BillingApp]).pipe(services));
  void billingOnly.handler(new Request("http://localhost"), Context.make(Tenant, "acme"));

  const both = Context.make(Tenant, "acme").pipe(
    Context.add(CurrentActor, { id: "alice", tenantId: "acme", permissions: [] }),
  );

  // Checked per adapter: over a union of both, one's requirements would hide the other's absence.
  const mergedHttp = HttpRouter.toWebHandler(
    Layer.mergeAll(Both.layer([App]), Both.layer([BillingApp])).pipe(
      Layer.provide(Users.layerMemory),
      services,
    ),
  );

  // @ts-expect-error Merged, the request requirements are the union over every implementation.
  void mergedHttp.handler(new Request("http://localhost"), Context.make(Tenant, "acme"));
  void mergedHttp.handler(new Request("http://localhost"), both);

  const mergedMcp = HttpRouter.toWebHandler(
    ActionMcp.layerHttp([App, BillingApp], {
      name: "test",
      version: "0",
      path: "/mcp",
    }).pipe(Layer.provide(Users.layerMemory), services),
  );

  // @ts-expect-error One endpoint requires the union over every implementation it serves.
  void mergedMcp.handler(new Request("http://localhost"), Context.make(Tenant, "acme"));
  void mergedMcp.handler(new Request("http://localhost"), both);

  // Implementing inline must not let the adapter's parameter type erase requirements.
  const inline = HttpRouter.toWebHandler(
    ActionHttp.make({ apiPath: "/api" }, Billing)
      .layer([Billing.implement({ invoice: () => Effect.succeed(1) })])
      .pipe(services),
  );

  void inline.handler(new Request("http://localhost"));

  const inlineMcp = HttpRouter.toWebHandler(
    ActionMcp.layerHttp([Billing.implement({ invoice: () => Effect.succeed(1) })], {
      name: "test",
      version: "0",
      path: "/mcp",
    }).pipe(services),
  );

  void inlineMcp.handler(new Request("http://localhost"));

  HttpRouter.toWebHandler(
    // @ts-expect-error Build requirements are the union over every merged layer.
    Layer.mergeAll(Both.layer([App]), Both.layer([BillingApp])).pipe(services),
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
  binding.layer([app], { before: () => Effect.fail(new Denied()) });

  // @ts-expect-error A hook may not fail with an error the surface does not declare.
  binding.layer([app], { before: () => Effect.fail(new Unrelated()) });

  const bare = ActionHttp.make({ apiPath: "/api" }, Guarded);
  // @ts-expect-error A binding without declared errors has no failure for a hook to use.
  bare.layer([app], { before: () => Effect.fail(new Denied()) });

  // The hook reads the contract it is about to run, including its access.
  binding.layer([app], {
    before: (action) => (action.access === "read" ? Effect.void : Effect.fail(new Denied())),
  });

  // Hook services are request-time requirements, exactly like a handler's.
  const timed = HttpRouter.toWebHandler(
    binding
      .layer([app], { before: () => Effect.asVoid(Clock) })
      .pipe(Layer.provide(HttpServer.layerServices)),
  );

  // @ts-expect-error The hook's services must be supplied per request, not erased.
  void timed.handler(new Request("http://localhost"), Context.empty());
  void timed.handler(new Request("http://localhost"), Context.make(Clock, 0));

  // MCP types its hook the same way, from the errors that endpoint declares.
  const stdio = ActionMcp.layerStdio([app], {
    name: "t",
    version: "0",
    errors: [Denied],
    before: () => Effect.asVoid(Clock),
  });

  // The hook's services join what the stdio host owes, since nothing else supplies them.
  stdio satisfies Layer.Layer<never, unknown, Stdio.Stdio | Clock>;

  ActionMcp.layerStdio([app], {
    name: "t",
    version: "0",
    errors: [Denied],
    // @ts-expect-error An MCP hook may not fail with an error the endpoint does not declare.
    before: () => Effect.fail(new Unrelated()),
  });
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

  /** What every request to a layer must carry. */
  type RequestServices<L extends Layer.Any> = HttpRouter.Request.Only<
    "Requires",
    Layer.Services<L>
  >;

  const mcpOptions = { name: "t", version: "0", path: "/mcp" } as const;
  const principal = () => Effect.map(Principal, (name) => name);

  // A mixed group: the action hidden from MCP is the only one that needs request identity.
  const Mixed = ActionGroup.make(
    { name: "mixed" },
    Action.make("public", { description: "Public", access: "read", success: Schema.String }),
    Action.make("hidden", {
      description: "Hidden from MCP",
      access: "write",
      success: Schema.String,
      mcp: false,
    }),
  ).implement({ public: () => Effect.succeed("public"), hidden: principal });

  // HTTP serves every action of a group it binds, so every request owes `Principal`.
  const http = ActionHttp.make({ apiPath: "/api" }, Mixed.group).layer([Mixed]);
  const httpOwes: Equal<RequestServices<typeof http>, Principal> = true;
  void httpOwes;

  // MCP does not serve the hidden action, so no request owes it.
  const mcp = ActionMcp.layerHttp([Mixed], mcpOptions);
  const mcpOwesNothing: Equal<RequestServices<typeof mcp>, never> = true;
  void mcpOwesNothing;

  // A group with nothing for MCP to serve is never acquired, so its build channel is absent.
  const Hidden = ActionGroup.make(
    { name: "hidden" },
    Action.make("only", {
      description: "Not a tool",
      access: "write",
      success: Schema.String,
      mcp: false,
    }),
  ).implement(
    Effect.fail("build" as const).pipe(
      Effect.tap(() => HiddenBuild),
      Effect.as({ only: () => Effect.succeed("") }),
    ),
  );

  const nothing = ActionMcp.layerHttp([Hidden], mcpOptions);
  const noBuildError: "build" extends Layer.Error<typeof nothing> ? false : true = true;
  const noBuildService: HiddenBuild extends Layer.Services<typeof nothing> ? false : true = true;
  void noBuildError;
  void noBuildService;

  // Only a required literal `false` hides an action from MCP. Options that may serve it
  // keep its requirements: a conditional spread, `false | undefined`, a runtime flag or
  // an `Options` value whose `mcp` is optional.
  const enabled: boolean = process.env["ENABLE"] !== "no";

  const Spread = ActionGroup.make(
    { name: "spread" },
    Action.make("act", {
      description: "Hidden when disabled",
      access: "read",
      success: Schema.String,
      ...(enabled ? {} : { mcp: false }),
    }),
  ).implement({ act: principal });

  const spread = ActionMcp.layerHttp([Spread], mcpOptions);
  const spreadOwes: Equal<RequestServices<typeof spread>, Principal> = true;
  void spreadOwes;

  const MaybeUndefined = ActionGroup.make(
    { name: "maybeUndefined" },
    Action.make("act", {
      description: "Hidden when disabled",
      access: "read",
      success: Schema.String,
      mcp: enabled ? undefined : false,
    }),
  ).implement({ act: principal });

  const maybeUndefined = ActionMcp.layerHttp([MaybeUndefined], mcpOptions);
  const maybeUndefinedOwes: Equal<RequestServices<typeof maybeUndefined>, Principal> = true;
  void maybeUndefinedOwes;

  const loose: Action.Options<typeof Schema.String, typeof Schema.String, [], "read", false> = {
    description: "Hidden or not",
    access: "read",
    success: Schema.String,
  };

  const Loose = ActionGroup.make({ name: "loose" }, Action.make("act", loose)).implement({
    act: principal,
  });

  const looseLayer = ActionMcp.layerHttp([Loose], mcpOptions);
  const looseOwes: Equal<RequestServices<typeof looseLayer>, Principal> = true;
  void looseOwes;

  // A runtime flag keeps the build channel too, since the group may be acquired.
  const Runtime = ActionGroup.make(
    { name: "runtime" },
    Action.make("maybe", {
      description: "Served when enabled",
      access: "read",
      success: Schema.String,
      mcp: enabled ? {} : false,
    }),
  ).implement(Effect.map(HiddenBuild, () => ({ maybe: principal })));

  const maybeMcp = ActionMcp.layerHttp([Runtime], mcpOptions);
  const mcpBuildKept: HiddenBuild extends Layer.Services<typeof maybeMcp> ? true : false = true;
  const runtimeOwes: Equal<RequestServices<typeof maybeMcp>, Principal> = true;
  void mcpBuildKept;
  void runtimeOwes;

  // Tool metadata serves the action; a literal `false` does not.
  const Hints = ActionGroup.make(
    { name: "hints" },
    Action.make("act", {
      description: "A tool",
      access: "read",
      success: Schema.String,
      mcp: { name: "hinted", idempotent: true },
    }),
  ).implement({ act: principal });

  const hints = ActionMcp.layerHttp([Hints], mcpOptions);
  const hintsOwe: Equal<RequestServices<typeof hints>, Principal> = true;
  void hintsOwe;

  const Literal = ActionGroup.make(
    { name: "literal" },
    Action.make("act", {
      description: "Not a tool",
      access: "read",
      success: Schema.String,
      mcp: false,
    }),
  ).implement({ act: principal });

  const literal = ActionMcp.layerHttp([Literal], mcpOptions);
  const literalOwesNothing: Equal<RequestServices<typeof literal>, never> = true;
  void literalOwesNothing;

  const Named = ActionGroup.make(
    { name: "named" },
    Action.make("act", {
      description: "Served when enabled",
      access: "read",
      success: Schema.String,
      mcp: enabled ? { name: "named_tool" } : false,
    }),
  ).implement({ act: principal });

  const named = ActionMcp.layerHttp([Named], mcpOptions);
  const namedOwes: Equal<RequestServices<typeof named>, Principal> = true;
  void namedOwes;

  // The Toolkit applies the same rule: an action that may be served is a tool that owes
  // its handler's services; only a literal `false` has no tool.
  const tools = {
    spread: ActionToolkit.make([Spread]).toolkit.tools,
    maybeUndefined: ActionToolkit.make([MaybeUndefined]).toolkit.tools,
    loose: ActionToolkit.make([Loose]).toolkit.tools,
    runtime: ActionToolkit.make([Runtime]).toolkit.tools,
    named: ActionToolkit.make([Named]).toolkit.tools,
    hints: ActionToolkit.make([Hints]).toolkit.tools,
    literal: ActionToolkit.make([Literal]).toolkit.tools,
  };

  type Tools = typeof tools;

  const toolAssertions: [
    Equal<Tool.HandlerServices<Tools["spread"]["act"]>, Principal>,
    Equal<Tool.HandlerServices<Tools["maybeUndefined"]["act"]>, Principal>,
    Equal<Tool.HandlerServices<Tools["loose"]["act"]>, Principal>,
    Equal<Tool.HandlerServices<Tools["runtime"]["maybe"]>, Principal>,
    Equal<Tool.HandlerServices<Tools["named"]["named_tool"]>, Principal>,
    Equal<Tool.HandlerServices<Tools["hints"]["hinted"]>, Principal>,
    Equal<keyof Tools["literal"], never>,
  ] = [true, true, true, true, true, true, true];

  void toolAssertions;

  Action.make("stale", {
    description: "Formerly hidden from HTTP",
    access: "read",
    success: Schema.String,
    // @ts-expect-error `http` is gone: HTTP serves every action of a group it binds.
    http: false,
  });
};
