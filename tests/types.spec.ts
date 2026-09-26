import { McpProtocol, McpSchema, Tool } from "effect/unstable/ai";
// Compile-only assertions, included by `vp check`, never executed by Vitest.
import { Context, Effect, Layer, Schema, type Stdio } from "effect";
import { HttpRouter, HttpServer } from "effect/unstable/http";
import { HttpApiClient } from "effect/unstable/httpapi";
import * as Action from "../src/Action.js";
import * as ActionHttp from "../src/ActionHttp.js";
import * as ActionHttpClient from "../src/ActionHttpClient.js";
import * as ActionMcp from "../src/ActionMcp.js";
import * as ActionToolkit from "../src/ActionToolkit.js";
import { makeTestHttp, makeTestMcp } from "./server.js";
import { CurrentActor } from "../examples/authorization.js";
import { Double, GetUser, RenameUser, WhoAmI } from "../examples/contracts.js";
import { userActions as App } from "../examples/handlers.js";
import { Users } from "../examples/users.js";
import type { Equal } from "./equal.js";

const Actions = [GetUser, RenameUser, Double, WhoAmI] as const;

const Http = ActionHttp.make(Actions);

/** What every request to a layer must carry. */
type RequestServices<L extends Layer.Any> = HttpRouter.Request.Only<"Requires", Layer.Services<L>>;

const services = Layer.provide(HttpServer.layerServices);

export const typeAssertions = () => {
  const actor = { id: "alice", tenantId: "acme", permissions: [] };

  const ok = {
    getUser: ({ id }: { id: string }) => Effect.succeed({ id, name: "Ada" }),
    renameUser: ({ id, name }: { id: string; name: string }) => Effect.succeed({ id, name }),
    double: ({ value }: { value: number }) => Effect.succeed(value * 2),
    whoAmI: () => Effect.succeed({ id: "alice", tenantId: "acme" }),
  };

  const single = Action.implement(Double, ok.double);
  // @ts-expect-error No public implementation Layer.
  void single.layer;
  // @ts-expect-error No public handler record.
  void single.handlers;
  // @ts-expect-error Implementations cannot be fabricated from a contract.
  ActionHttp.layer(Http, [{ actions: [Double] }]);
  // @ts-expect-error Spreading a nominal implementation cannot manufacture its private builder.
  // oxlint-disable-next-line typescript/no-misused-spread -- Deliberate nominal-fabrication compile-failure fixture.
  ActionHttp.layer(Http, [{ ...single, actions: [Double] }]);
  // @ts-expect-error Every listed action needs a handler.
  Action.implement(Actions, { ...ok, whoAmI: undefined });
  // @ts-expect-error Handler results must match the success schema.
  Action.implement(Actions, { ...ok, double: ({ value }) => Effect.succeed(String(value)) });
  // @ts-expect-error Handlers may only fail with the declared errors.
  Action.implement(Actions, { ...ok, double: () => Effect.fail(new Error("undeclared")) });
  Action.implement(Actions, {
    ...ok,
    // @ts-expect-error Handlers receive the decoded input, number rather than its wire string.
    double: ({ value }: { value: string }) => Effect.succeed(Number(value)),
  });
  Action.implement(Actions, {
    ...ok,
    // @ts-expect-error Input fields come from the schema.
    // oxlint-disable-next-line typescript/no-unsafe-assignment -- Compile-failure fixture: the rejected field yields an error type; nothing runs.
    getUser: ({ userId }) => Effect.succeed({ id: userId, name: "" }),
  });
  // @ts-expect-error A single action takes its handler, not a record.
  Action.implement(Double, ok);
  // @ts-expect-error A single handler's result must match the success schema.
  Action.implement(Double, () => Effect.succeed("two"));
  // @ts-expect-error A single handler may only fail with the declared errors.
  Action.implement(Double, () => Effect.fail(new Error("undeclared")));

  HttpRouter.toWebHandler(
    // @ts-expect-error Build-time handler dependencies are Layer requirements.
    ActionHttp.layer(Http, App).pipe(services),
  );

  const http = HttpRouter.toWebHandler(
    ActionHttp.layer(Http, App).pipe(Layer.provide(Users.layerMemory), services),
  );

  // @ts-expect-error Request-scoped handler dependencies must be present per request.
  void http.handler(new Request("http://localhost"), Context.empty());
  void http.handler(new Request("http://localhost"), Context.make(CurrentActor, actor));

  // MCP carries the same request requirement as HTTP; forgetting middleware is a compile error.
  const mcpLayer = ActionMcp.layerHttp(App, { name: "t", version: "0" });

  // @ts-expect-error Build-time handler dependencies are Layer requirements.
  HttpRouter.toWebHandler(mcpLayer.pipe(services));
  const mcp = HttpRouter.toWebHandler(mcpLayer.pipe(Layer.provide(Users.layerMemory), services));
  // @ts-expect-error Request-scoped handler dependencies must be present per request.
  void mcp.handler(new Request("http://localhost/mcp"), Context.empty());
  void mcp.handler(new Request("http://localhost/mcp"), Context.make(CurrentActor, actor));

  // The native server supplies its own request context, so the stdio host owes only `Stdio`.
  const contextual = Action.implement(
    Action.make("client", {
      description: "Client",
      access: "write",
      success: Schema.String,
      hints: {},
    }),
    () => Effect.map(McpSchema.McpRequestContext, (context) => context.clientInfo?.name ?? ""),
  );

  const stdio: Layer.Layer<never, unknown, Stdio.Stdio> = ActionMcp.layerStdio(contextual, {
    name: "t",
    version: "0",
  });

  void stdio;

  const requestActor = Layer.succeed(CurrentActor, actor);

  const requestOnly = Action.implement(Actions, {
    ...ok,
    whoAmI: () => Effect.map(CurrentActor, ({ id, tenantId }) => ({ id, tenantId })),
  });

  // @ts-expect-error Test helpers require an explicit request Layer.
  makeTestHttp([requestOnly]);
  // @ts-expect-error Test helpers must not erase missing request services.
  makeTestHttp([requestOnly], Layer.empty);
  // @ts-expect-error Test helpers require an explicit request Layer.
  makeTestMcp([requestOnly]);
  // @ts-expect-error Test helpers must not erase missing request services.
  makeTestMcp([requestOnly], Layer.empty);
  makeTestHttp([requestOnly], requestActor);
  makeTestMcp([requestOnly], requestActor);

  const fallible = Action.implement(
    Actions,
    Effect.fail("build-failed" as const).pipe(Effect.as(ok)),
  );

  for (const routes of [
    ActionHttp.layer(Http, fallible),
    ActionMcp.layerHttp(fallible, { name: "test", version: "0" }),
  ]) {
    const build = Layer.build(routes.pipe(Layer.provide(HttpRouter.layer), services)).pipe(
      Effect.scoped,
    );

    // @ts-expect-error Private bindings must not erase acquisition failures.
    void (build satisfies Effect.Effect<unknown, never>);
  }
};

export const implementTypes = () => {
  class Store extends Context.Service<
    Store,
    { readonly name: (id: string) => Effect.Effect<string> }
  >()("types-spec/Store") {}

  class Principal extends Context.Service<Principal, string>()("types-spec/ImplementPrincipal") {}

  class BuildFailed extends Schema.TaggedError<BuildFailed>()("BuildFailed", {}) {}

  // Fields shorthand: a record of fields stands for the struct of them, input and success.
  const Lookup = Action.make("lookup", {
    description: "Lookup",
    access: "read",
    input: { id: Schema.String, limit: Schema.optionalKey(Schema.Finite) },
    success: { id: Schema.String, name: Schema.String },
  });

  const lookupInput: Equal<
    (typeof Lookup)["input"]["Type"],
    { readonly id: string; readonly limit?: number }
  > = true;

  const lookupSuccess: Equal<
    (typeof Lookup)["success"]["Type"],
    { readonly id: string; readonly name: string }
  > = true;

  void lookupInput;
  void lookupSuccess;

  const Rename = Action.make("rename", {
    description: "Rename",
    access: "write",
    input: Schema.Struct({ id: Schema.String, name: Schema.String }),
    success: Schema.String,
  });

  // One action, one handler: its parameter is typed from the contract.
  const plain = Action.implement(Lookup, ({ id }) =>
    Effect.succeed({ id, name: id.toUpperCase() }),
  );

  // One implementation, whose request requirements are kept per action name.
  const plainChannels: [
    Equal<
      Action.Implementation<typeof Lookup, { readonly lookup: never }, never, never>,
      typeof plain
    >,
  ] = [true];

  void plainChannels;

  // One action, one builder: startup services are separate from the handler's.
  const built = Action.implement(
    Lookup,
    Effect.gen(function* () {
      const store = yield* Store;

      return ({ id }) =>
        Effect.flatMap(Principal, () => Effect.map(store.name(id), (name) => ({ id, name })));
    }),
  );

  const builtChannels: Equal<
    Action.Implementation<typeof Lookup, { readonly lookup: Principal }, never, Store>,
    typeof built
  > = true;

  void builtChannels;

  // Several actions, one record: each handler is typed from its own contract.
  const record = Action.implement([Lookup, Rename], {
    lookup: ({ id }) => Effect.succeed({ id, name: "" }),
    rename: ({ name }) => Effect.succeed(name),
  });

  // Several actions, one builder: failures and services are shared, requests are per handler.
  const shared = Action.implement(
    [Lookup, Rename],
    Effect.gen(function* () {
      const store = yield* Store;

      if (Math.random() > 2) return yield* new BuildFailed();

      return {
        lookup: ({ id }) => Effect.map(store.name(id), (name) => ({ id, name })),
        rename: ({ name }) => Effect.as(Principal, name),
      };
    }),
  );

  const incomplete = Effect.succeed({ lookup: () => Effect.succeed({ id: "", name: "" }) });
  // @ts-expect-error A list's builder must supply every handler.
  Action.implement([Lookup, Rename], incomplete);
  // @ts-expect-error A builder's handlers may only fail with declared errors.
  Action.implement([Lookup], Effect.succeed({ lookup: () => Effect.fail("nope" as const) }));

  // Per action: the shared builder's `rename` owes `Principal`, its `lookup` nothing.
  const sharedRequests: Equal<
    (typeof shared)["~request"],
    { readonly lookup: never; readonly rename: Principal }
  > = true;

  void sharedRequests;

  // Surfaces take implementations as they are, and compute their requirements from them.
  const all = [plain, built, record, shared];
  const http = ActionHttp.make([Lookup, Rename]);

  // HTTP serves `rename`, so the request owes its `Principal`; builders owe `Store`.
  const routes = ActionHttp.layer(http, all);
  const httpRequest: Equal<RequestServices<typeof routes>, Principal> = true;
  const httpBuild: Store extends Layer.Services<typeof routes> ? true : false = true;
  const httpError: Equal<Layer.Error<typeof routes>, BuildFailed> = true;
  void httpRequest;
  void httpBuild;
  void httpError;

  // MCP serves what it is given: the shared builder's channels and `rename`'s request.
  const tools = ActionMcp.layerHttp([plain, shared], { name: "t", version: "0" });
  const mcpRequest: Equal<RequestServices<typeof tools>, Principal> = true;
  const mcpBuild: Store extends Layer.Services<typeof tools> ? true : false = true;
  const mcpError: "BuildFailed" extends Layer.Error<typeof tools>["_tag"] ? true : false = true;
  void mcpRequest;
  void mcpBuild;
  void mcpError;

  const Foreign = Action.make("foreign", {
    description: "Foreign",
    access: "read",
    success: Schema.String,
  });

  const foreign = Action.implement(Foreign, () => Effect.succeed(""));
  // @ts-expect-error Route layers exist only for implementations of the bound actions.
  ActionHttp.layer(http, foreign);
  // @ts-expect-error A list of implementations is not a list of contracts.
  ActionHttp.make(all);
};

export const clientTypes = Effect.gen(function* () {
  const client = yield* ActionHttpClient.make(Http);
  const doubled: number = yield* client.double({ value: 21 });
  void doubled;
  // No-input actions take no argument.
  yield* client.whoAmI();
  // @ts-expect-error Actions with input need their argument.
  client.double();
  // @ts-expect-error No-input actions reject invented fields.
  client.whoAmI({ actor: "alice" });
  // @ts-expect-error Action names are exact.
  // oxlint-disable-next-line typescript/no-unsafe-call -- Compile-failure fixture: the rejected method yields an error type; nothing runs.
  client.missing({});
  // @ts-expect-error Clients take decoded, not wire, inputs.
  client.double({ value: "21" });
  // @ts-expect-error Results retain the success type.
  const wrong: string = yield* client.double({ value: 21 });
  void wrong;

  // The native client stays available: a flat binding is one top-level group.
  const native = yield* HttpApiClient.make(Http.api);
  const nativeDoubled: number = yield* native.double({ payload: { value: 21 } });
  void nativeDoubled;
  // @ts-expect-error Native methods require the payload wrapper.
  native.double({ value: 21 });
});

export const builtInErrorTypes = Effect.gen(function* () {
  class Unrelated extends Schema.TaggedError<Unrelated>()("Unrelated", {}) {}

  const Echo = Action.make("echo", {
    description: "Echo",
    access: "write",
    input: { value: Schema.Finite },
    success: Schema.Finite,
  });

  const bound = ActionHttp.make([Echo]);

  // A binding is plain data: its actions, where they are mounted, and the native API.
  const fields: Equal<keyof typeof bound, "actions" | "prefix" | "api"> = true;
  void fields;

  // @ts-expect-error Refusals belong to the surface, not to handlers.
  Action.implement(Echo, () => Effect.fail(new Action.Forbidden()));
  // @ts-expect-error Bad input is answered before a handler runs, not by it.
  Action.implement(Echo, () => Effect.fail(new Action.InvalidInput()));
  // @ts-expect-error Surface errors are built in, not declared on the binding.
  ActionHttp.make([Echo], { errors: [Unrelated] });

  // Every built-in error reaches every client method as a typed failure.
  const client = yield* ActionHttpClient.make(bound);
  yield* client.echo({ value: 1 }).pipe(
    Effect.catchTag("InvalidInput", () => Effect.succeed(0)),
    Effect.catchTag("Unauthenticated", () => Effect.succeed(0)),
    Effect.catchTag("Forbidden", () => Effect.succeed(0)),
  );

  const native = yield* HttpApiClient.make(bound.api);
  yield* native.echo({ payload: { value: 1 } }).pipe(
    Effect.catchTag("InvalidInput", () => Effect.succeed(0)),
    Effect.catchTag("Unauthenticated", () => Effect.succeed(0)),
    Effect.catchTag("Forbidden", () => Effect.succeed(0)),
  );

  yield* client
    .echo({ value: 1 })
    // @ts-expect-error Undeclared, so the client has no such failure to catch.
    .pipe(Effect.catchTag("Unrelated", () => Effect.succeed(0)));
});

export const configuredAdapterTypes = () => {
  const Bound = ActionHttp.make(Actions, { prefix: "/rpc" });
  // @ts-expect-error A configured binding must preserve acquisition requirements.
  HttpRouter.toWebHandler(ActionHttp.layer(Bound, App).pipe(services));

  const web = HttpRouter.toWebHandler(
    ActionHttp.layer(Bound, App).pipe(Layer.provide(Users.layerMemory), services),
  );

  // @ts-expect-error Configuring the binding must preserve request requirements.
  void web.handler(new Request("http://localhost"), Context.empty());
  // @ts-expect-error A prefix is an absolute path.
  ActionHttp.make(Actions, { prefix: "api" });
  ActionMcp.layerHttp(App, {
    name: "test",
    version: "0",
    // @ts-expect-error The protocol revision is fixed at 2026-07-28.
    protocols: [McpProtocol.v2026_07_28],
  });
  ActionMcp.layerStdio(App, {
    name: "test",
    version: "0",
    // @ts-expect-error The protocol revision is fixed at 2026-07-28.
    protocols: [McpProtocol.v2026_07_28],
  });
  // Both mount paths have defaults: `/api` and `/mcp`.
  ActionHttp.make(Actions);
  // @ts-expect-error The group name, which is the OpenAPI tag, is the mount path.
  ActionHttp.make(Actions, { prefix: "/users", name: "users" });
  // The document is served from the binding, not from a layer of it.
  ActionHttp.openApi(Bound) satisfies Layer.Layer<never, never, HttpRouter.HttpRouter>;
  ActionHttp.openApi(Bound, "/openapi.json");
  ActionMcp.layerHttp(App, { name: "test", version: "0" });
  // @ts-expect-error MCP server information is required.
  ActionMcp.layerHttp(App, { path: "/mcp" });
};

export const layerTypes = () => {
  class Tenant extends Context.Service<Tenant, string>()("types/Tenant") {}

  class BuildA extends Context.Service<BuildA, string>()("types/BuildA") {}

  class BuildB extends Context.Service<BuildB, string>()("types/BuildB") {}

  const Invoice = Action.make("invoice", {
    description: "Invoice",
    access: "write",
    success: Schema.Number,
  });

  const billingApp = Action.implement(Invoice, () => Effect.as(Tenant, 1));

  const Both = ActionHttp.make([...Actions, Invoice]);

  // One top-level native group, so native methods are not nested either.
  void Effect.gen(function* () {
    const native = yield* HttpApiClient.make(Both.api);
    const nativeTotal: number = yield* native.invoice({ payload: {} });
    void nativeTotal;
  });

  ActionHttp.layer(Both, [App, billingApp]);

  const failsAfterBuildA = Action.implement(
    Invoice,
    Effect.fail("build-a" as const).pipe(
      Effect.tap(() => BuildA),
      Effect.as(() => Effect.succeed(1)),
    ),
  );

  const failsAfterBuildB = Action.implement(
    Actions,
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

  const combined = ActionHttp.layer(Both, [failsAfterBuildA, failsAfterBuildB]);
  // @ts-expect-error One layer preserves both disjoint build-service requirements.
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

  // Each layer carries only its own implementations' requirements.
  const billingOnly = HttpRouter.toWebHandler(ActionHttp.layer(Both, billingApp).pipe(services));
  void billingOnly.handler(new Request("http://localhost"), Context.make(Tenant, "acme"));

  const both = Context.make(Tenant, "acme").pipe(
    Context.add(CurrentActor, { id: "alice", tenantId: "acme", permissions: [] }),
  );

  // Checked per adapter: over a union of both, one's requirements would hide the other's absence.
  const mergedHttp = HttpRouter.toWebHandler(
    Layer.mergeAll(ActionHttp.layer(Both, App), ActionHttp.layer(Both, billingApp)).pipe(
      Layer.provide(Users.layerMemory),
      services,
    ),
  );

  // @ts-expect-error Merged, the request requirements are the union over every implementation.
  void mergedHttp.handler(new Request("http://localhost"), Context.make(Tenant, "acme"));
  void mergedHttp.handler(new Request("http://localhost"), both);

  const mergedMcp = HttpRouter.toWebHandler(
    ActionMcp.layerHttp([App, billingApp], { name: "test", version: "0" }).pipe(
      Layer.provide(Users.layerMemory),
      services,
    ),
  );

  // @ts-expect-error One endpoint requires the union over every implementation it serves.
  void mergedMcp.handler(new Request("http://localhost"), Context.make(Tenant, "acme"));
  void mergedMcp.handler(new Request("http://localhost"), both);

  // Implementing inline must not let the adapter's parameter type erase requirements.
  const inline = HttpRouter.toWebHandler(
    ActionHttp.layer(
      ActionHttp.make([Invoice]),
      Action.implement(Invoice, () => Effect.succeed(1)),
    ).pipe(services),
  );

  void inline.handler(new Request("http://localhost"));

  const inlineMcp = HttpRouter.toWebHandler(
    ActionMcp.layerHttp(
      Action.implement(Invoice, () => Effect.succeed(1)),
      {
        name: "test",
        version: "0",
      },
    ).pipe(services),
  );

  void inlineMcp.handler(new Request("http://localhost"));

  HttpRouter.toWebHandler(
    // @ts-expect-error Build requirements are the union over every merged layer.
    Layer.mergeAll(ActionHttp.layer(Both, App), ActionHttp.layer(Both, billingApp)).pipe(services),
  );
};

export const beforeTypes = () => {
  class Denied extends Schema.TaggedError<Denied>()("Denied", {}, { httpApiStatus: 403 }) {}

  class Clock extends Context.Service<Clock, number>()("types-spec/Clock") {}

  const Read = Action.make("read", {
    description: "Read",
    access: "read",
    success: Schema.String,
  });

  const app = Action.implement(Read, () => Effect.succeed("ok"));

  const binding = ActionHttp.make([Read]);

  // The hook may fail with either refusal, which every endpoint declares.
  ActionHttp.layer(binding, app, { before: () => Effect.fail(new Action.Forbidden()) });
  ActionHttp.layer(binding, app, { before: () => Effect.fail(new Action.Unauthenticated()) });

  // @ts-expect-error A hook may not fail with anything but a refusal, even a 403 of its own.
  ActionHttp.layer(binding, app, { before: () => Effect.fail(new Denied()) });
  // @ts-expect-error Bad input is answered before the hook runs, not by it.
  ActionHttp.layer(binding, app, { before: () => Effect.fail(new Action.InvalidInput()) });

  // One hook binds to every surface; there is no `errors` to declare alongside it.
  const guard = {
    before: (action: Action.Any) =>
      action.access === "read" ? Effect.void : Effect.fail(new Action.Forbidden()),
  };

  ActionHttp.layer(binding, app, guard);
  ActionMcp.layerHttp(app, { name: "t", version: "0", ...guard });
  ActionToolkit.make(app, guard);

  // @ts-expect-error Surfaces take no `errors`: the refusals are built in.
  ActionHttp.layer(binding, app, { errors: [Denied], ...guard });

  // The hook reads the contract it is about to run, including its access.
  ActionHttp.layer(binding, app, {
    before: (action) =>
      action.access === "read" ? Effect.void : Effect.fail(new Action.Forbidden()),
  });

  // Hook services are request-time requirements, exactly like a handler's.
  const timed = HttpRouter.toWebHandler(
    ActionHttp.layer(binding, app, { before: () => Effect.asVoid(Clock) }).pipe(services),
  );

  // @ts-expect-error The hook's services must be supplied per request, not erased.
  void timed.handler(new Request("http://localhost"), Context.empty());
  void timed.handler(new Request("http://localhost"), Context.make(Clock, 0));

  // MCP types its hook the same way.
  const stdio = ActionMcp.layerStdio(app, {
    name: "t",
    version: "0",
    before: () => Effect.asVoid(Clock),
  });

  // The hook's services join what the stdio host owes, since nothing else supplies them.
  stdio satisfies Layer.Layer<never, unknown, Stdio.Stdio | Clock>;

  ActionMcp.layerStdio(app, {
    name: "t",
    version: "0",
    // @ts-expect-error An MCP hook may not fail with anything but a refusal.
    before: () => Effect.fail(new Denied()),
  });
};

export const servedRequirementTypes = () => {
  class Principal extends Context.Service<Principal, string>()("types-spec/Principal") {}

  const principal = () => Effect.map(Principal, (name) => name);

  const hintsApp = Action.implement(
    Action.make("act", {
      description: "A tool",
      access: "read",
      success: Schema.String,
      hints: { idempotent: true },
    }),
    principal,
  );

  Action.make("typo", {
    description: "Typo",
    access: "read",
    success: Schema.String,
    // @ts-expect-error A misspelled option is an unknown property, not silently ignored.
    hint: { idempotent: true },
  });

  // Every hint is resolved on the contract.
  const resolved: Equal<
    (typeof hintsApp)["actions"][number]["hints"],
    Required<Action.Hints>
  > = true;

  void resolved;

  // A tool is named after its action, and owes its handler's services.
  const tools = ActionToolkit.make(hintsApp).toolkit.tools;

  const toolAssertions: [
    Equal<keyof typeof tools, "act">,
    Equal<Tool.HandlerServices<(typeof tools)["act"]>, Principal>,
    // Every tool declares the refusals a `before` hook may fail with.
    Equal<Tool.Failure<(typeof tools)["act"]>, Action.Unauthenticated | Action.Forbidden>,
  ] = [true, true, true];

  void toolAssertions;
};
