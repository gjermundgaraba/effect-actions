import { McpProtocol, McpSchema, Tool } from "effect/ai";
import { Context, Data, Effect, Layer, Redacted, Schema, type Stdio } from "effect";
import {
  type HttpClient,
  type HttpClientError,
  type HttpClientRequest,
  HttpRouter,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/http";
import { HttpApiClient, HttpApiError } from "effect/http-api";
import { expectTypeOf } from "@effect/vitest";
import * as Action from "../../src/contract/Action.js";
import * as ActionHttp from "../../src/http/ActionHttp.js";
import * as ActionMcp from "../../src/mcp/ActionMcp.js";
import * as ActionToolkit from "../../src/toolkit/ActionToolkit.js";
import * as Authentication from "../../src/authentication/Authentication.js";
import * as Testing from "../../src/testing/Testing.js";
import { makeTestHttp, makeTestMcp } from "../support/server.js";
import { CurrentActor } from "../../examples/authorization.js";
import { Double, GetUser, RenameUser, WhoAmI } from "../../examples/contracts.js";
import { authenticate } from "../../examples/authentication.js";
import { Login } from "../../examples/binding.js";
import { userActions } from "../../examples/handlers.js";
import { Users } from "../../examples/users.js";

const Actions = [GetUser, RenameUser, Double, WhoAmI] as const;

const Http = ActionHttp.make(Actions, { authentication: Login });

type RequestServices<L extends Layer.Any> = HttpRouter.Request.Only<"Requires", Layer.Services<L>>;

const services = Layer.provide(HttpServer.layerServices);

const App = Action.implement(
  [GetUser, RenameUser, WhoAmI],
  Effect.gen(function* () {
    const users = yield* Users;

    return {
      getUser: ({ id }) => Effect.flatMap(CurrentActor, (actor) => users.get(actor.tenantId, id)),
      renameUser: ({ id, name }) =>
        Effect.flatMap(CurrentActor, (actor) => users.rename(actor, id, name)),
      whoAmI: () => Effect.map(CurrentActor, ({ id, tenantId }) => ({ id, tenantId })),
    };
  }),
  { authorize: Action.allowAll },
);

type CallServices<
  App extends Action.AnyImplementation,
  K extends keyof Action.Client<App>,
> = Action.Client<App>[K] extends (...input: never) => infer E ? Effect.Services<E> : never;

export const typeAssertions = () => {
  const ok = {
    getUser: ({ id }: { id: string }) => Effect.succeed({ id, name: "Ada" }),
    renameUser: ({ id, name }: { id: string; name: string }) => Effect.succeed({ id, name }),
    double: ({ value }: { value: number }) => Effect.succeed(value * 2),
    whoAmI: () => Effect.succeed({ id: "alice", tenantId: "acme" }),
  };

  const single = Action.implement(Double, ok.double, { authorize: Action.allowAll });
  // @ts-expect-error -- No public implementation Layer.
  void single.layer;
  // @ts-expect-error -- No public handler record.
  void single.handlers;
  // @ts-expect-error -- Implementations cannot be fabricated from a contract.
  ActionHttp.layer(Http, [{ actions: [Double] }]);
  // @ts-expect-error -- Spreading a nominal implementation cannot manufacture its private builder.
  // oxlint-disable-next-line typescript/no-misused-spread -- Deliberate nominal-fabrication compile-failure fixture.
  ActionHttp.layer(Http, [{ ...single, actions: [Double] }]);
  // @ts-expect-error -- Every listed action needs a handler.
  Action.implement(Actions, { ...ok, whoAmI: undefined }, { authorize: Action.allowAll });
  Action.implement(
    Actions,
    // @ts-expect-error -- Handler results must match the success schema.
    { ...ok, double: ({ value }) => Effect.succeed(String(value)) },
    { authorize: Action.allowAll },
  );
  Action.implement(
    Actions,
    // @ts-expect-error -- Handlers may only fail with the declared errors.
    { ...ok, double: () => Effect.fail(new Error("undeclared")) },
    { authorize: Action.allowAll },
  );
  Action.implement(
    Actions,
    {
      ...ok,
      // @ts-expect-error -- Handlers receive the decoded input, number rather than its wire string.
      double: ({ value }: { value: string }) => Effect.succeed(Number(value)),
    },
    { authorize: Action.allowAll },
  );
  Action.implement(
    Actions,
    {
      ...ok,
      // @ts-expect-error -- Input fields come from the schema.
      // oxlint-disable-next-line typescript/no-unsafe-assignment -- Compile-failure fixture: the rejected field yields an error type; nothing runs.
      getUser: ({ userId }) => Effect.succeed({ id: userId, name: "" }),
    },
    { authorize: Action.allowAll },
  );
  // @ts-expect-error -- A single action takes its handler, not a record.
  Action.implement(Double, ok, { authorize: Action.allowAll });
  // @ts-expect-error -- A single handler's result must match the success schema.
  Action.implement(Double, () => Effect.succeed("two"), { authorize: Action.allowAll });

  HttpRouter.toWebHandler(
    // @ts-expect-error -- Build-time handler dependencies are Layer requirements.
    ActionHttp.layer(Http, App).pipe(Layer.provide(authenticate), services),
  );

  const mcpLayer = ActionMcp.layerHttp(App, { name: "t", version: "0", authentication: Login });

  // @ts-expect-error -- Build-time handler dependencies are Layer requirements.
  HttpRouter.toWebHandler(mcpLayer.pipe(Layer.provide(authenticate), services));
  // @ts-expect-error -- The identity is the verifier's: no request context stands in for it.
  HttpRouter.toWebHandler(mcpLayer.pipe(Layer.provide(Users.layerMemory), services));

  const mcp = HttpRouter.toWebHandler(
    mcpLayer.pipe(Layer.provide(authenticate), Layer.provide(Users.layerMemory), services),
  );

  void mcp.handler(new Request("http://localhost/mcp"), Context.empty());

  const contextual = Action.implement(
    Action.make("client", {
      description: "Client",
      readOnly: false,
      caller: Action.Anyone,
      success: Schema.String,
      mcp: {},
    }),
    () => Effect.map(McpSchema.McpRequestContext, (context) => context.clientInfo?.name ?? ""),
  );

  const stdio: Effect.Effect<void, unknown, Stdio.Stdio> = ActionMcp.runStdio(contextual, {
    name: "t",
    version: "0",
  });

  void stdio;

  const requestOnly = Action.implement(
    Action.make("whoever", {
      description: "",
      readOnly: true,
      caller: Action.Anyone,
      success: WhoAmI.success,
    }),
    () => Effect.map(CurrentActor, ({ id, tenantId }) => ({ id, tenantId })),
  );

  // @ts-expect-error -- Test helpers must not erase missing request services.
  makeTestHttp([requestOnly]);
  // @ts-expect-error -- Test helpers must not erase missing request services.
  makeTestMcp([requestOnly]);
};

export const implementTypes = () => {
  class Store extends Context.Service<
    Store,
    { readonly name: (id: string) => Effect.Effect<string> }
  >()("types-spec/Store") {}

  class Principal extends Context.Service<Principal, string>()("types-spec/ImplementPrincipal") {}

  class Secret extends Context.Service<Secret, string>()("types-spec/ImplementSecret") {}

  class BuildFailed extends Schema.TaggedError<BuildFailed>()("BuildFailed", {}) {}

  const Lookup = Action.make("lookup", {
    description: "Lookup",
    readOnly: true,
    caller: Action.Anyone,
    input: { id: Schema.String, limit: Schema.optionalKey(Schema.Finite) },
    success: { id: Schema.String, name: Schema.String },
  });

  expectTypeOf<(typeof Lookup)["input"]["Type"]>().toEqualTypeOf<{
    readonly id: string;
    readonly limit?: number;
  }>();

  expectTypeOf<(typeof Lookup)["success"]["Type"]>().toEqualTypeOf<{
    readonly id: string;
    readonly name: string;
  }>();

  const Rename = Action.make("rename", {
    description: "Rename",
    readOnly: false,
    caller: Action.Anyone,
    input: Schema.Struct({ id: Schema.String, name: Schema.String }),
    success: Schema.String,
  });

  const Secured = Action.make("secured", {
    description: "Rename, signed in",
    readOnly: false,
    caller: Principal,
    input: Schema.Struct({ id: Schema.String, name: Schema.String }),
    success: Schema.String,
  });

  const PrincipalLogin = Authentication.make("types-spec.PrincipalLogin", Principal);

  const plain = Action.implement(Lookup, ({ id }) =>
    Effect.succeed({ id, name: id.toUpperCase() }),
  );

  expectTypeOf<CallServices<typeof plain, "lookup">>().toBeNever();
  expectTypeOf(Action.layer(plain)).toEqualTypeOf<Layer.Layer<never, never, never>>();

  const built = Action.implement(
    Lookup,
    Effect.gen(function* () {
      const store = yield* Store;

      return ({ id }) =>
        Effect.flatMap(Principal, () => Effect.map(store.name(id), (name) => ({ id, name })));
    }),
  );

  expectTypeOf<CallServices<typeof built, "lookup">>().toEqualTypeOf<Principal>();
  expectTypeOf(Action.layer(built)).toEqualTypeOf<Layer.Layer<never, never, Store>>();

  const record = Action.implement([Lookup, Rename], {
    lookup: ({ id }) => Effect.succeed({ id, name: "" }),
    rename: ({ name }) => Effect.succeed(name),
  });

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
  // @ts-expect-error -- A list's builder must supply every handler.
  Action.implement([Lookup, Rename], incomplete);
  Action.implement(
    [Lookup],
    // @ts-expect-error -- A builder's handlers may only fail with declared errors.
    Effect.succeed({ lookup: () => Effect.fail("nope" as const) }),
  );

  class Scopes extends Context.Service<Scopes, ReadonlySet<string>>()("types-spec/Scopes") {}

  const authorized = Action.implement(
    [Lookup, Secured],
    {
      lookup: ({ id }) => Effect.succeed({ id, name: "" }),
      secured: ({ name }) => Effect.as(Store, name),
    },
    { authorize: () => Effect.asVoid(Scopes) },
  );

  const opened = ActionHttp.layer(ActionHttp.make([Lookup]), authorized);

  const closed = ActionHttp.layer(
    ActionHttp.make([Lookup, Secured], { authentication: PrincipalLogin }),
    authorized,
  );

  expectTypeOf<RequestServices<typeof opened>>().toBeNever();
  expectTypeOf<RequestServices<typeof closed>>().toEqualTypeOf<Store | Scopes>();

  const acquired = <A>(value: A) => Effect.acquireRelease(Effect.succeed(value), () => Effect.void);

  const scoped = Action.implement(
    [Lookup, Secured],
    {
      lookup: ({ id }) => Effect.flatMap(Secret, () => acquired({ id, name: "" })),
      secured: ({ name }) => acquired(name),
    },
    { authorize: () => Effect.asVoid(acquired(true)) },
  );

  const stdio = ActionMcp.runStdio(scoped, { name: "t", version: "0" });

  expectTypeOf<Effect.Services<typeof stdio>>().toEqualTypeOf<Stdio.Stdio | Principal | Secret>();

  const endpoint = ActionMcp.layerHttp(scoped, {
    name: "t",
    version: "0",
    authentication: PrincipalLogin,
  });

  expectTypeOf<RequestServices<typeof endpoint>>().toEqualTypeOf<Secret>();

  const selected = ActionMcp.runStdio(scoped, { name: "t", version: "0", actions: [Secured] });

  expectTypeOf<Effect.Services<typeof selected>>().toEqualTypeOf<Stdio.Stdio | Principal>();

  const Headers = Action.make("headers", {
    description: "",
    readOnly: true,
    caller: Action.Anyone,
    success: Schema.String,
  });

  const readsRequest = Action.implement(Headers, () =>
    Effect.map(Effect.service(HttpServerRequest.HttpServerRequest), (request) => request.url),
  );

  expectTypeOf<
    RequestServices<
      ReturnType<typeof ActionHttp.layer<ActionHttp.Binding<[typeof Headers]>, typeof readsRequest>>
    >
  >().toBeNever();
  expectTypeOf<
    RequestServices<ReturnType<typeof ActionMcp.layerHttp<typeof readsRequest>>>
  >().toBeNever();

  Testing.layer(ActionHttp.layer(ActionHttp.make([Headers]), readsRequest));

  const guardedRoutes = ActionHttp.layer(
    ActionHttp.make([GetUser, RenameUser, WhoAmI], { authentication: Login }),
    userActions,
  );

  const authenticated = Testing.layer(guardedRoutes.pipe(Layer.provide(authenticate)));
  const asCaller = Testing.layer(guardedRoutes);

  class Tenant extends Context.Service<Tenant, string>()("types-spec/Tenant") {}

  const audited = Testing.layer(
    Layer.mergeAll(
      ActionHttp.layer(ActionHttp.make([Headers]), readsRequest),
      HttpRouter.middleware((route) => Effect.flatMap(Tenant, () => route), { global: true }),
    ),
  );

  const file = Testing.layer(HttpRouter.add("GET", "/file", HttpServerResponse.file("file.txt")));

  expectTypeOf<Layer.Services<typeof authenticated>>().toEqualTypeOf<Users>();
  expectTypeOf<Layer.Services<typeof asCaller>>().toEqualTypeOf<
    Users | Layer.Success<typeof authenticate>
  >();
  expectTypeOf<Layer.Services<typeof audited>>().toEqualTypeOf<Tenant>();
  expectTypeOf<Layer.Services<typeof file>>().toBeNever();

  const all = [plain, built, record, shared];
  const http = ActionHttp.make([Lookup, Rename]);

  const routes = ActionHttp.layer(http, all);
  expectTypeOf<RequestServices<typeof routes>>().toEqualTypeOf<Principal>();
  expectTypeOf<Store>().toExtend<Layer.Services<typeof routes>>();
  expectTypeOf<Layer.Error<typeof routes>>().toEqualTypeOf<BuildFailed>();

  const tools = ActionMcp.layerHttp([plain, shared], { name: "t", version: "0" });
  expectTypeOf<RequestServices<typeof tools>>().toEqualTypeOf<Principal>();
  expectTypeOf<Store>().toExtend<Layer.Services<typeof tools>>();
  expectTypeOf<"BuildFailed">().toExtend<Layer.Error<typeof tools>["_tag"]>();

  // @ts-expect-error -- A list of implementations is not a list of contracts.
  ActionHttp.make(all);
};

export const clientTypes = Effect.gen(function* () {
  const client = yield* ActionHttp.client(Http);
  const doubled: number = yield* client.double({ value: 21 });
  void doubled;
  yield* client.whoAmI();
});

export const builtInErrorTypes = () => {
  const Echo = Action.make("echo", {
    description: "Echo",
    readOnly: false,
    caller: Action.Anyone,
    input: { value: Schema.Finite },
    success: Schema.Finite,
  });

  const bound = ActionHttp.make([Echo]);

  expectTypeOf<keyof typeof bound>().toEqualTypeOf<
    "actions" | "error" | "prefix" | "api" | "authentication"
  >();
  expectTypeOf(bound.authentication).toBeUndefined();

  const native = HttpApiClient.make(bound.api);

  expectTypeOf<Action.BuiltIn>().toExtend<
    Effect.Error<ReturnType<Effect.Success<typeof native>["echo"]>>
  >();

  Action.implement(Echo, () => Effect.fail(new Action.Forbidden({ scopes: ["admin"] })));
  Action.implement(Echo, () => Effect.fail(new Action.InvalidInput({ message: "Too many" })));
  Action.make("listed", {
    description: "",
    readOnly: false,
    caller: Action.Anyone,
    // @ts-expect-error -- No action lists a built-in error: every surface declares it.
    error: [Action.Forbidden],
  });
  // @ts-expect-error -- Only those and the declared errors.
  Action.implement(Echo, () => Effect.fail(new Error("undeclared")));

  class Forbidden extends Data.TaggedError("Forbidden")<{ readonly message: string }> {}

  expectTypeOf<HttpApiError.Forbidden>().not.toExtend<Action.Forbidden>();
  expectTypeOf<Forbidden>().not.toExtend<Action.Forbidden>();
  // @ts-expect-error -- Effect's `Forbidden`.
  Action.implement(Echo, () => Effect.fail(new HttpApiError.Forbidden({})));
  // @ts-expect-error -- The application's look-alike.
  Action.implement(Echo, () => Effect.fail(new Forbidden({ message: "No." })));
};

export const configuredSurfaceTypes = () => {
  // @ts-expect-error -- A prefix is an absolute path.
  ActionHttp.make(Actions, { prefix: "api" });
  ActionMcp.layerHttp(App, {
    name: "test",
    version: "0",
    authentication: Login,
    // @ts-expect-error -- The protocol revision is fixed at 2026-07-28.
    protocols: [McpProtocol.v2026_07_28],
  });
  ActionMcp.runStdio(App, {
    name: "test",
    version: "0",
    // @ts-expect-error -- Stdio negotiates its own revisions: it takes no `protocols` option.
    protocols: [McpProtocol.v2026_07_28],
  });
  // @ts-expect-error -- MCP server information is required.
  ActionMcp.layerHttp(App, { path: "/mcp", authentication: Login });
};

export const layerTypes = () => {
  class Tenant extends Context.Service<Tenant, string>()("types/Tenant") {}

  class BuildA extends Context.Service<BuildA, string>()("types/BuildA") {}

  class BuildB extends Context.Service<BuildB, string>()("types/BuildB") {}

  class Region extends Context.Service<Region, string>()("types/Region") {}

  const Invoice = Action.make("invoice", {
    description: "Invoice",
    readOnly: false,
    caller: Action.Anyone,
    success: Schema.Number,
  });

  const Report = Action.make("report", {
    description: "Report",
    readOnly: true,
    caller: Action.Anyone,
    success: Schema.Number,
  });

  const billingApp = Action.implement(Invoice, () => Effect.as(Tenant, 1));
  const reportApp = Action.implement(Report, () => Effect.as(Region, 1));

  const Both = ActionHttp.make([...Actions, Invoice, Report], { authentication: Login });

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
    { authorize: Action.allowAll },
  );

  const combined = ActionHttp.layer(Both, [failsAfterBuildA, failsAfterBuildB]);
  // @ts-expect-error -- One layer preserves both disjoint build-service requirements.
  HttpRouter.toWebHandler(combined.pipe(Layer.provide(authenticate), services));

  expectTypeOf<Layer.Error<typeof combined>>().toEqualTypeOf<"build-a" | "build-b">();
  expectTypeOf<BuildA>().toExtend<Layer.Services<typeof combined>>();
  expectTypeOf<BuildB>().toExtend<Layer.Services<typeof combined>>();
  HttpRouter.toWebHandler(
    combined.pipe(
      Layer.provide(Layer.succeed(BuildA, "a")),
      Layer.provide(Layer.succeed(BuildB, "b")),
      Layer.provide(authenticate),
      services,
    ),
  );

  const billingOnly = HttpRouter.toWebHandler(ActionHttp.layer(Both, billingApp).pipe(services));
  void billingOnly.handler(new Request("http://localhost"), Context.make(Tenant, "acme"));

  const both = Context.make(Tenant, "acme").pipe(Context.add(Region, "eu"));

  const mergedHttp = HttpRouter.toWebHandler(
    Layer.mergeAll(
      ActionHttp.layer(Both, App),
      ActionHttp.layer(Both, billingApp),
      ActionHttp.layer(Both, reportApp),
    ).pipe(Layer.provide(authenticate), Layer.provide(Users.layerMemory), services),
  );

  // @ts-expect-error -- Merged, the request requirements are the union over every implementation.
  void mergedHttp.handler(new Request("http://localhost"), Context.make(Tenant, "acme"));
  void mergedHttp.handler(new Request("http://localhost"), both);

  const mergedMcp = HttpRouter.toWebHandler(
    ActionMcp.layerHttp([App, billingApp, reportApp], {
      name: "test",
      version: "0",
      authentication: Login,
    }).pipe(Layer.provide(authenticate), Layer.provide(Users.layerMemory), services),
  );

  // @ts-expect-error -- One endpoint requires the union over every implementation it serves.
  void mergedMcp.handler(new Request("http://localhost"), Context.make(Tenant, "acme"));
  void mergedMcp.handler(new Request("http://localhost"), both);

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
};

export const authorizeTypes = () => {
  class Denied extends Schema.TaggedError<Denied>()("Denied", {}, { httpApiStatus: 403 }) {}

  class Clock extends Context.Service<Clock, number>()("types-spec/Clock") {}

  const Read = Action.make("read", {
    description: "Read",
    readOnly: true,
    caller: CurrentActor,
    success: Schema.String,
  });

  const read = () => Effect.succeed("ok");

  const binding = ActionHttp.make([Read], { authentication: Login });

  Action.implement(Read, read, { authorize: () => Effect.fail(new Action.Forbidden()) });
  Action.implement(Read, read, { authorize: () => Effect.fail(new Action.Unauthenticated()) });

  // @ts-expect-error -- Nor with an error of its own, even a 403.
  Action.implement(Read, read, { authorize: () => Effect.fail(new Denied()) });
  // @ts-expect-error -- Bad input is answered before authorization runs, not by it.
  Action.implement(Read, read, { authorize: () => Effect.fail(new Action.InvalidInput()) });

  Action.implement(Read, read, {
    authorize: (action) => {
      expectTypeOf(action).toEqualTypeOf<typeof Read>();

      return action.readOnly ? Effect.void : Effect.fail(new Action.Forbidden());
    },
  });

  const clocked = Action.implement(Read, read, { authorize: () => Effect.asVoid(Clock) });

  const timed = HttpRouter.toWebHandler(
    ActionHttp.layer(binding, clocked).pipe(Layer.provide(authenticate), services),
  );

  // @ts-expect-error -- Authorization's services must be supplied per request, not erased.
  void timed.handler(new Request("http://localhost"), Context.empty());
  void timed.handler(new Request("http://localhost"), Context.make(Clock, 0));

  const stdio = ActionMcp.runStdio(clocked, { name: "t", version: "0" });
  expectTypeOf<Effect.Services<typeof stdio>>().toEqualTypeOf<Stdio.Stdio | Clock | CurrentActor>();
};

export const declaredErrorTypes = () => {
  class RateLimited extends Schema.TaggedError<RateLimited>()(
    "RateLimited",
    { retryAfter: Schema.Finite },
    { httpApiStatus: 429 },
  ) {}

  class NotFound extends Schema.TaggedError<NotFound>()("NotFound", { id: Schema.String }) {}

  class Conflict extends Schema.TaggedError<Conflict>()("Conflict", {}) {}

  class Limiter extends Context.Service<
    Limiter,
    { readonly take: (key: string) => Effect.Effect<void, RateLimited> }
  >()("types-spec/Limiter") {}

  const Get = Action.make("get", {
    description: "Get",
    readOnly: true,
    caller: CurrentActor,
    success: Schema.String,
    error: [NotFound, RateLimited],
  });

  const Put = Action.make("put", {
    description: "Put",
    readOnly: false,
    caller: CurrentActor,
    success: Schema.String,
    error: [NotFound, Conflict, RateLimited],
  });

  const Status = Action.make("status", {
    description: "Status",
    readOnly: true,
    caller: Action.Anyone,
  });

  expectTypeOf<(typeof Put)["error"][number]["Type"]>().toEqualTypeOf<
    NotFound | Conflict | RateLimited
  >();

  const Find = Action.make("find", {
    description: "Find",
    readOnly: true,
    caller: Action.Anyone,
    error: NotFound,
  });

  expectTypeOf<(typeof Find)["error"][number]["Type"]>().toEqualTypeOf<NotFound>();
  expectTypeOf(ActionHttp.make([Find], { error: RateLimited }).error).toEqualTypeOf<
    readonly [typeof RateLimited]
  >();
  Action.make("refused", {
    description: "",
    readOnly: true,
    caller: Action.Anyone,
    // @ts-expect-error -- Every surface declares `Forbidden` already.
    error: Action.Forbidden,
  });

  expectTypeOf<(typeof Status)["error"]>().toEqualTypeOf<ReadonlyArray<never>>();

  type Fails<A extends Action.Any> = Effect.Error<ReturnType<Action.Authorize<A>>>;

  expectTypeOf<Fails<typeof Put>>().toEqualTypeOf<Action.Refusal>();
  expectTypeOf<Fails<typeof Get | typeof Put>>().toEqualTypeOf<Action.Refusal>();
  expectTypeOf<Fails<Action.Any>>().toEqualTypeOf<Action.Refusal>();

  const limit = () => Effect.fail(new RateLimited({ retryAfter: 30 }));

  const handlers = { get: () => Effect.succeed(""), put: () => Effect.succeed("") };

  // @ts-expect-error -- The limit is the handler's to fail with, though every action declares it.
  Action.implement([Get, Put], handlers, { authorize: limit });
  // @ts-expect-error -- So is an error of an action's own.
  Action.implement(Put, handlers.put, { authorize: () => Effect.fail(new Conflict()) });

  const authorize: Action.Authorize<Action.Any> = (action) =>
    action.readOnly ? Effect.void : Effect.fail(new Action.Forbidden());

  // @ts-expect-error -- Typed over any action, an authorizer cannot fail with an error of its own.
  const unbounded: Action.Authorize<Action.Any> = limit;

  void unbounded;

  const limited = Action.implement(
    [Get, Put],
    Effect.gen(function* () {
      const limiter = yield* Limiter;

      const take = (name: string) =>
        Effect.flatMap(CurrentActor, ({ id }) => limiter.take(`${id}/${name}`));

      return {
        get: () => Effect.as(take("get"), ""),
        put: () => Effect.as(take("put"), ""),
      };
    }),
    { authorize },
  );

  expectTypeOf(Action.layer(limited)).toEqualTypeOf<Layer.Layer<never, never, Limiter>>();
  expectTypeOf<CallServices<typeof limited, "get">>().toEqualTypeOf<CurrentActor>();

  // @ts-expect-error -- A handler fails only with what its action declares: `Status` declares no limit.
  Action.implement(Status, limit);
};

export const requiredAuthorizeTypes = () => {
  const Read = Action.make("read", {
    description: "Read",
    readOnly: true,
    caller: CurrentActor,
    success: Schema.String,
  });

  const read = () => Effect.succeed("ok");

  // @ts-expect-error -- A protected implementation with neither an authorizer nor `Action.allowAll` is refused.
  Action.implement(Read, read);
  // @ts-expect-error -- `undefined` is not an authorizer either.
  Action.implement(Read, read, undefined);
  // @ts-expect-error -- Nor is an option left `undefined`.
  Action.implement(Read, read, { authorize: undefined });
  Action.implement(Read, read, { authorize: Action.allowAll });
};

export const effectFnHandlerTypes = () => {
  class Principal extends Context.Service<Principal, string>()("types-spec/FnPrincipal") {}

  class Suffix extends Context.Service<Suffix, string>()("types-spec/FnSuffix") {}

  const Lookup = Action.make("lookup", {
    description: "Lookup",
    readOnly: true,
    caller: Action.Anyone,
    input: { id: Schema.String },
    success: { id: Schema.String, name: Schema.String },
  });

  const Rename = Action.make("rename", {
    description: "Rename",
    readOnly: false,
    caller: Action.Anyone,
    input: { id: Schema.String, name: Schema.String },
    success: Schema.String,
  });

  const single = Action.implement(
    Lookup,
    Effect.fn(function* ({ id }) {
      return { id, name: yield* Principal };
    }),
  );

  const record = Action.implement([Lookup, Rename], {
    lookup: Effect.fn("lookup")(function* ({ id }) {
      return { id, name: yield* Effect.succeed(id.toUpperCase()) };
    }),
    rename: Effect.fnUntraced(function* ({ name }) {
      return `${name} (${yield* Principal})`;
    }),
  });

  const built = Action.implement(
    Lookup,
    Effect.gen(function* () {
      const suffix = yield* Suffix;

      return Effect.fn(function* ({ id }) {
        return { id, name: `${yield* Principal}${suffix}` };
      });
    }),
  );

  expectTypeOf<CallServices<typeof single, "lookup">>().toEqualTypeOf<Principal>();
  expectTypeOf<CallServices<typeof record, "lookup">>().toBeNever();
  expectTypeOf<CallServices<typeof record, "rename">>().toEqualTypeOf<Principal>();
  expectTypeOf<CallServices<typeof built, "lookup">>().toEqualTypeOf<Principal>();
  expectTypeOf(Action.layer(built)).toEqualTypeOf<Layer.Layer<never, never, Suffix>>();

  Action.implement(
    Lookup,
    Effect.gen(function* () {
      const suffix = yield* Suffix;

      // @ts-expect-error -- A builder's `Effect.fn`: the input has no such field.
      return Effect.fn(function* ({ idd }) {
        return { id: String(idd), name: `${yield* Principal}${suffix}` };
      });
    }),
  );

  Action.implement(
    Lookup,
    Effect.map(Suffix, (suffix) =>
      // @ts-expect-error -- A builder's `Effect.fn(name)`: the input has no such field.
      Effect.fn("lookup")(function* ({ idd }) {
        return { id: String(idd), name: `${yield* Principal}${suffix}` };
      }),
    ),
  );

  Action.implement(
    Lookup,
    Effect.succeed(
      // @ts-expect-error -- A builder's `Effect.fnUntraced`: the input has no such field.
      Effect.fnUntraced(function* ({ idd }) {
        return { id: String(idd), name: yield* Principal };
      }),
    ),
  );

  Action.implement(
    Lookup,
    // @ts-expect-error -- `Effect.fn`: the input has no such field.
    Effect.fn(function* ({ idd }) {
      return { id: String(idd), name: yield* Principal };
    }),
  );

  Action.implement(
    Lookup,
    // @ts-expect-error -- `Effect.fn(name)`: the input has no such field.
    Effect.fn("lookup")(function* ({ idd }) {
      return { id: String(idd), name: yield* Principal };
    }),
  );

  Action.implement(
    Lookup,
    // @ts-expect-error -- `Effect.fnUntraced`: the input has no such field.
    Effect.fnUntraced(function* ({ idd }) {
      return { id: String(idd), name: yield* Principal };
    }),
  );

  Action.implement([Lookup, Rename], {
    lookup: Effect.fn(function* ({ id }) {
      // @ts-expect-error -- `Effect.fn` in a record: a string has no such method.
      // oxlint-disable-next-line typescript/no-unsafe-call, typescript/no-unsafe-assignment -- Compile-failure fixture: the rejected method yields an error type; nothing runs.
      const shouted: string = id.toUpperCas();

      return { id: shouted, name: yield* Principal };
    }),
    rename: ({ name }) => Effect.succeed(name),
  });

  Action.implement([Lookup, Rename], {
    lookup: ({ id }) => Effect.succeed({ id, name: "" }),
    // @ts-expect-error -- `Effect.fn(name)` in a record: the input has no such field.
    rename: Effect.fn("rename")(function* ({ nam }) {
      return `${String(nam)} (${yield* Principal})`;
    }),
  });

  Action.implement([Lookup, Rename], {
    lookup: ({ id }) => Effect.succeed({ id, name: "" }),
    // @ts-expect-error -- `Effect.fnUntraced` in a record: the input has no such field.
    rename: Effect.fnUntraced(function* ({ nam }) {
      return `${String(nam)} (${yield* Principal})`;
    }),
  });

  // @ts-expect-error -- One action takes its handler, not a record keyed by its name.
  Action.implement(Lookup, { lookup: () => Effect.succeed({ id: "", name: "" }) });
  // @ts-expect-error -- A list takes a record of handlers, not one handler.
  Action.implement([Lookup, Rename], () => Effect.never);
};

export const deferredTypes = () => {
  class Store extends Context.Service<Store, string>()("types-spec/DeferredStore") {}

  class Clock extends Context.Service<Clock, number>()("types-spec/DeferredClock") {}

  const Stamp = Action.make("stamp", {
    description: "Stamp",
    readOnly: true,
    caller: Action.Anyone,
    success: Schema.String,
  });

  const Echo = Action.make("echo", {
    description: "Echo",
    readOnly: true,
    caller: Action.Anyone,
    input: { value: Schema.String },
    success: Schema.String,
  });

  const binding = ActionHttp.make([Stamp, Echo]);

  const stamp = Action.implement(
    Stamp,
    Effect.gen(function* () {
      const store = yield* Store;
      const clock = yield* Clock;

      return () => Effect.succeed(`${store}@${clock}`);
    }),
  );

  HttpRouter.toWebHandler(
    ActionHttp.layer(binding, stamp).pipe(
      Layer.provide(Layer.succeed(Store, "store")),
      Layer.provide(Layer.succeed(Clock, 0)),
      services,
    ),
  );

  const listed = ActionHttp.layer(binding, [
    stamp,
    Action.implement(Echo, ({ value }) => Effect.succeed(value)),
  ]);

  expectTypeOf<
    Extract<Layer.Services<typeof listed>, Store | Clock | HttpRouter.Request<"Requires", unknown>>
  >().toEqualTypeOf<Store | Clock>();

  // @ts-expect-error -- A forgotten startup service of a sibling is still refused.
  HttpRouter.toWebHandler(listed.pipe(Layer.provide(Layer.succeed(Store, "store")), services));
  HttpRouter.toWebHandler(
    listed.pipe(
      Layer.provide(Layer.succeed(Store, "store")),
      Layer.provide(Layer.succeed(Clock, 0)),
      services,
    ),
  );

  const endpoint = ActionMcp.layerHttp(
    [stamp, Action.implement(Echo, ({ value }) => Effect.succeed(value))],
    { name: "t", version: "0" },
  );

  const stdio = ActionMcp.runStdio(
    [stamp, Action.implement(Echo, ({ value }) => Effect.succeed(value))],
    { name: "t", version: "0" },
  );

  const tools = ActionToolkit.make([
    stamp,
    Action.implement(Echo, ({ value }) => Effect.succeed(value)),
  ]);

  const builders = Action.layer([
    stamp,
    Action.implement(Echo, ({ value }) => Effect.succeed(value)),
  ]);

  expectTypeOf<Layer.Services<typeof endpoint>>().toEqualTypeOf<
    Store | Clock | HttpRouter.HttpRouter
  >();
  expectTypeOf<Effect.Services<typeof stdio>>().toEqualTypeOf<Store | Clock | Stdio.Stdio>();
  expectTypeOf<Layer.Services<typeof tools.layer>>().toEqualTypeOf<Store | Clock>();
  expectTypeOf<Layer.Error<typeof tools.layer>>().toBeNever();
  expectTypeOf<typeof builders>().toEqualTypeOf<Layer.Layer<never, never, Store | Clock>>();
};

export const builtAuthorizerTypes = () => {
  class Permissions extends Context.Service<
    Permissions,
    { readonly allows: (actor: string, readOnly: boolean) => boolean }
  >()("types-spec/Permissions") {}

  class Actor extends Context.Service<Actor, string>()("types-spec/Actor") {}

  class Unavailable extends Schema.TaggedError<Unavailable>()("Unavailable", {}) {}

  const ActorLogin = Authentication.make("types-spec.ActorLogin", Actor);

  const verified = Authentication.layer(ActorLogin, (token: Redacted.Redacted<string>) =>
    Effect.succeed(Redacted.value(token)),
  );

  const Lookup = Action.make("lookup", {
    description: "Lookup",
    readOnly: true,
    caller: Actor,
    success: Schema.String,
  });

  const Rename = Action.make("rename", {
    description: "Rename",
    readOnly: false,
    caller: Actor,
    success: Schema.String,
  });

  const handlers = { lookup: () => Effect.succeed(""), rename: () => Effect.succeed("") };

  const guarded = Action.implement([Lookup, Rename], handlers, {
    authorize: Effect.gen(function* () {
      const permissions = yield* Permissions;

      if (Math.random() > 2) return yield* new Unavailable();

      return (action) =>
        Effect.gen(function* () {
          const name: "lookup" | "rename" = action.name;
          // @ts-expect-error -- No other action.
          const other: "other" = action.name;

          void [name, other];

          if (!permissions.allows(yield* Actor, action.readOnly)) {
            return yield* new Action.Forbidden();
          }
        });
    }),
  });

  expectTypeOf<CallServices<typeof guarded, "lookup">>().toEqualTypeOf<Actor>();
  expectTypeOf(Action.layer(guarded)).toEqualTypeOf<Layer.Layer<never, Unavailable, Permissions>>();

  const routes = ActionHttp.layer(
    ActionHttp.make([Lookup, Rename], { authentication: ActorLogin }),
    guarded,
  );

  const permitted = Layer.succeed(Permissions, { allows: () => true });

  HttpRouter.toWebHandler(
    // @ts-expect-error -- Without the verifier, nothing provides the identity it reads.
    routes.pipe(Layer.provide(permitted), Layer.provide(HttpRouter.layer), services),
  );

  const provided = HttpRouter.toWebHandler(
    routes.pipe(
      Layer.provide(verified),
      Layer.provide(permitted),
      Layer.provide(HttpRouter.layer),
      services,
    ),
  );

  void provided.handler(new Request("http://localhost"), Context.empty());

  Action.implement([Lookup, Rename], handlers, {
    // @ts-expect-error -- A built authorizer, too, fails only with a refusal.
    authorize: Effect.succeed(() => Effect.fail(new Unavailable())),
  });

  const admin = Action.implement(Rename, handlers.rename, {
    authorize: Effect.map(
      Actor,
      (actor) => () => (actor === "root" ? Effect.void : Effect.fail(new Action.Forbidden())),
    ),
  });

  expectTypeOf<CallServices<typeof admin, "rename">>().toEqualTypeOf<Actor>();
  expectTypeOf(Action.layer(admin)).toEqualTypeOf<Layer.Layer<never, never, Actor>>();

  class Guard extends Context.Service<Guard, Action.Authorize<Action.Any, Permissions>>()(
    "types-spec/Guard",
  ) {}

  const serviced = Action.implement([Lookup, Rename], handlers, { authorize: Guard });

  expectTypeOf<CallServices<typeof serviced, "lookup">>().toEqualTypeOf<Actor | Permissions>();
  expectTypeOf(Action.layer(serviced)).toEqualTypeOf<Layer.Layer<never, never, Guard>>();

  class Audit extends Context.Service<Audit, string>()("types-spec/Audit") {}

  const anyLookup: Action.Any = Lookup;
  const auditHook = () => Effect.asVoid(Audit);

  const unused = () => Effect.die("unused");

  const erasedOne = Action.implement(anyLookup, unused, { authorize: auditHook });
  const erasedList = Action.implement([anyLookup], { lookup: unused }, { authorize: auditHook });

  expectTypeOf<Audit>().toExtend<CallServices<typeof erasedOne, string>>();
  expectTypeOf<Audit>().toExtend<CallServices<typeof erasedList, string>>();

  const generated = Action.implement([Lookup, Rename], handlers, {
    authorize: Effect.gen(function* () {
      const permissions = yield* Permissions;

      if (Math.random() > 2) return yield* new Unavailable();

      return Effect.fn(function* (action) {
        const name: "lookup" | "rename" = action.name;
        // @ts-expect-error -- No other action.
        const other: "other" = action.name;

        void [name, other];

        // @ts-expect-error -- A misspelled field is refused, not read as `undefined`.
        if (action.redOnly === false) return yield* new Action.Forbidden();

        if (!permissions.allows(yield* Actor, action.readOnly)) {
          return yield* new Action.Forbidden();
        }
      });
    }),
  });

  const single = Action.implement(Lookup, handlers.lookup, {
    authorize: Effect.map(Permissions, (permissions) =>
      Effect.fn("authorize")(function* (action) {
        const name: "lookup" = action.name;
        // @ts-expect-error -- Only its own action.
        const other: "rename" = action.name;

        void [name, other];

        if (!permissions.allows(yield* Actor, action.readOnly)) {
          return yield* new Action.Forbidden();
        }
      }),
    ),
  });

  const reviewed = Action.implement(Rename, handlers.rename, {
    authorize: Effect.gen(function* () {
      const permissions = yield* Permissions;

      return Effect.fnUntraced(function* (action) {
        const name: "rename" = action.name;
        // @ts-expect-error -- Only its own action.
        const other: "lookup" = action.name;

        void [name, other];

        if (!permissions.allows(yield* Actor, action.readOnly)) {
          return yield* new Action.Forbidden();
        }
      });
    }),
  });

  expectTypeOf<CallServices<typeof generated, "lookup">>().toEqualTypeOf<Actor>();
  expectTypeOf(Action.layer(generated)).toEqualTypeOf<
    Layer.Layer<never, Unavailable, Permissions>
  >();
  expectTypeOf<CallServices<typeof single, "lookup">>().toEqualTypeOf<Actor>();
  expectTypeOf(Action.layer(single)).toEqualTypeOf<Layer.Layer<never, never, Permissions>>();
  expectTypeOf<CallServices<typeof reviewed, "rename">>().toEqualTypeOf<Actor>();
  expectTypeOf(Action.layer(reviewed)).toEqualTypeOf<Layer.Layer<never, never, Permissions>>();

  const tools = ActionToolkit.make(
    Action.implement([Lookup, Rename], handlers, {
      authorize: Effect.gen(function* () {
        const permissions = yield* Permissions;

        return Effect.fn(function* (action) {
          // @ts-expect-error -- A misspelled field is refused, not read as `undefined`.
          if (action.redOnly === false) return yield* new Action.Forbidden();

          if (!permissions.allows(yield* Actor, action.readOnly)) {
            return yield* new Action.Forbidden();
          }
        });
      }),
    }),
  );

  expectTypeOf<Tool.HandlerServices<typeof tools.toolkit.tools.rename>>().toEqualTypeOf<Actor>();
  expectTypeOf<Layer.Services<typeof tools.layer>>().toEqualTypeOf<Permissions>();
};

export const erasedImplementationTypes = () => {
  class Store extends Context.Service<Store, string>()("types-spec/ErasedStore") {}

  const Stored = Action.make("stored", {
    description: "Stored",
    readOnly: true,
    caller: Action.Anyone,
    success: Schema.String,
  });

  const stored = Action.implement(
    Stored,
    Effect.map(Store, (store) => () => Effect.succeed(store)),
  );

  const host = <
    const Apps extends Action.AnyImplementation | ReadonlyArray<Action.AnyImplementation>,
  >(
    apps: Apps,
  ) => ActionMcp.runStdio(apps, { name: "t", version: "0" });

  expectTypeOf<Effect.Services<ReturnType<typeof host<[typeof stored]>>>>().toEqualTypeOf<
    Store | Stdio.Stdio
  >();

  const StoredHttp = ActionHttp.make([Stored]);

  const routes = <
    const Apps extends Action.AnyImplementation | ReadonlyArray<Action.AnyImplementation>,
  >(
    apps: Apps,
  ) => ActionHttp.layer(StoredHttp, apps);

  // @ts-expect-error -- A forgotten startup service is refused through the helper.
  HttpRouter.toWebHandler(routes([stored]).pipe(services));
  HttpRouter.toWebHandler(routes([stored]).pipe(Layer.provide(Layer.succeed(Store, "")), services));
  HttpRouter.toWebHandler(routes(stored).pipe(Layer.provide(Layer.succeed(Store, "")), services));

  const anyBinding = <const H extends ActionHttp.Any>(http: H) => ActionHttp.layer(http, stored);

  const byBinding = <
    const H extends ActionHttp.Any,
    const App extends Action.AnyImplementation<H["actions"][number]>,
  >(
    http: H,
    app: App,
  ) => ActionHttp.layer(http, app);

  // @ts-expect-error -- A forgotten startup service is refused through the helper.
  HttpRouter.toWebHandler(anyBinding(StoredHttp).pipe(services));
  HttpRouter.toWebHandler(
    anyBinding(StoredHttp).pipe(Layer.provide(Layer.succeed(Store, "")), services),
  );
  // @ts-expect-error -- A forgotten startup service is refused through the helper.
  HttpRouter.toWebHandler(byBinding(StoredHttp, stored).pipe(services));

  const Paired = Action.make("paired", {
    description: "Paired",
    readOnly: true,
    caller: Action.Anyone,
    success: Schema.String,
  });

  const paired = Action.implement(Paired, () => Effect.succeed(""));
  const PairedHttp = ActionHttp.make([Stored, Paired]);

  const serveBeside = <const Apps extends ReadonlyArray<Action.AnyImplementation>>(apps: Apps) =>
    ActionHttp.layer(PairedHttp, [...apps, paired]);

  const serveListed = <App extends Action.AnyImplementation>(app: App) =>
    ActionHttp.layer(PairedHttp, [app, paired]);

  // @ts-expect-error -- A forgotten startup service is refused through the helper.
  HttpRouter.toWebHandler(serveBeside([stored]).pipe(services));
  HttpRouter.toWebHandler(
    serveBeside([stored]).pipe(Layer.provide(Layer.succeed(Store, "")), services),
  );
  // @ts-expect-error -- The same, listed.
  HttpRouter.toWebHandler(serveListed(stored).pipe(services));
  HttpRouter.toWebHandler(
    serveListed(stored).pipe(Layer.provide(Layer.succeed(Store, "")), services),
  );

  const erased: ReadonlyArray<Action.AnyImplementation> = [stored];
  const layer = ActionMcp.layerHttp(erased, { name: "t", version: "0", authentication: Login });
  const erasedRoutes = ActionHttp.layer(StoredHttp, erased);

  expectTypeOf<Layer.Services<typeof layer>>().toBeUnknown();
  expectTypeOf<Layer.Services<typeof erasedRoutes>>().toBeUnknown();

  HttpRouter.toWebHandler(
    // @ts-expect-error -- No surface serves what is typed with the erased type alone.
    layer.pipe(Layer.provide(Layer.succeed(Store, "")), services),
  );
  HttpRouter.toWebHandler(
    // @ts-expect-error -- No surface serves what is typed with the erased type alone.
    erasedRoutes.pipe(Layer.provide(Layer.succeed(Store, "")), services),
  );
};

export const bindingSelectionTypes = () => {
  class Store extends Context.Service<Store, string>()("types-spec/SelectedStore") {}

  class Gate extends Context.Service<Gate, string>()("types-spec/Gate") {}

  class Reviewer extends Context.Service<Reviewer, string>()("types-spec/Reviewer") {}

  const Read = Action.make("read", {
    description: "Read",
    readOnly: true,
    caller: CurrentActor,
    success: Schema.String,
  });

  const Audit = Action.make("audit", {
    description: "Audit",
    readOnly: true,
    caller: CurrentActor,
    success: Schema.String,
  });

  const app = Action.implement(
    [Read, Audit],
    Effect.map(Store, (store) => ({
      read: () => Effect.succeed(store),
      audit: () => Effect.map(Reviewer, (reviewer) => reviewer),
    })),
    { authorize: () => Effect.asVoid(Gate) },
  );

  const Http = ActionHttp.make([Read], { authentication: Login });
  const routes = ActionHttp.layer(Http, app);

  expectTypeOf<RequestServices<typeof routes>>().toEqualTypeOf<Gate>();
  expectTypeOf<Store>().toExtend<Layer.Services<typeof routes>>();

  const tools = ActionMcp.layerHttp(app, { name: "t", version: "0", authentication: Login });
  const erasedBinding: ActionHttp.Any = Http;
  const anyRoutes = ActionHttp.layer(erasedBinding, app);

  expectTypeOf<RequestServices<typeof tools>>().toEqualTypeOf<Gate | Reviewer>();
  expectTypeOf<RequestServices<typeof anyRoutes>>().toEqualTypeOf<Gate | Reviewer>();

  // @ts-expect-error -- A security scheme is Effect's own.
  Authentication.make("types-spec.Bearer", CurrentActor, { security: "Bearer" });
};

export const authenticationTypes = () => {
  HttpRouter.toWebHandler(
    // @ts-expect-error -- The verifier must be provided, not erased.
    ActionHttp.layer(Http, userActions).pipe(Layer.provide(Users.layerMemory), services),
  );

  const http = HttpRouter.toWebHandler(
    ActionHttp.layer(Http, userActions).pipe(
      Layer.provide(authenticate),
      Layer.provide(Users.layerMemory),
      services,
    ),
  );

  void http.handler(new Request("http://localhost"), Context.empty());

  const mcp = HttpRouter.toWebHandler(
    ActionMcp.layerHttp(userActions, { name: "t", version: "0", authentication: Login }).pipe(
      Layer.provide(authenticate),
      Layer.provide(Users.layerMemory),
      services,
    ),
  );

  void mcp.handler(new Request("http://localhost/mcp"), Context.empty());

  const stdio = ActionMcp.runStdio(userActions, { name: "t", version: "0" });
  expectTypeOf<Effect.Services<typeof stdio>>().toEqualTypeOf<Users | Stdio.Stdio | CurrentActor>();

  const tools = ActionToolkit.make(userActions).toolkit.tools;
  expectTypeOf<Tool.HandlerServices<typeof tools.getUser>>().toEqualTypeOf<CurrentActor>();
};

export const authenticationLayerTypes = () => {
  class Identity extends Context.Service<Identity, { readonly id: string }>()("types/Identity") {}

  class Tenant extends Context.Service<Tenant, string>()("types/Tenant") {}

  class Verifier extends Context.Service<
    Verifier,
    {
      readonly verify: (
        tenant: string,
        token: string,
      ) => Effect.Effect<{ readonly id: string }, Action.Unauthenticated>;
    }
  >()("types/Verifier") {}

  const IdentityLogin = Authentication.make("types.IdentityLogin", Identity);

  const Who = Action.make("who", {
    description: "Who",
    readOnly: true,
    caller: Identity,
    success: Schema.String,
  });

  const who = Action.implement(Who, () => Effect.map(Identity, ({ id }) => id), {
    authorize: Action.allowAll,
  });

  const routes = ActionHttp.layer(ActionHttp.make([Who], { authentication: IdentityLogin }), who);

  const resolveTenant = HttpRouter.middleware<{ provides: Tenant }>()((route) =>
    Effect.provideService(route, Tenant, "acme"),
  );

  const verified = Authentication.layer(
    IdentityLogin,
    Effect.gen(function* () {
      const { verify } = yield* Verifier;
      yield* Effect.addFinalizer(() => Effect.void);

      return (token: Redacted.Redacted<string>) =>
        Effect.gen(function* () {
          const tenant = yield* Tenant;
          yield* HttpServerRequest.HttpServerRequest;

          return yield* verify(tenant, Redacted.value(token));
        });
    }),
  );

  expectTypeOf<Layer.Services<typeof verified>>().toEqualTypeOf<
    Verifier | HttpRouter.Request<"Requires", Tenant>
  >();
  expectTypeOf<Layer.Error<typeof verified>>().toBeNever();

  const tenanted = routes.pipe(Layer.provide(verified), Layer.provide(resolveTenant.layer));

  expectTypeOf<RequestServices<typeof tenanted>>().toBeNever();
  expectTypeOf<Verifier>().toExtend<Layer.Services<typeof tenanted>>();

  const beside = routes.pipe(Layer.provide([verified, resolveTenant.layer]));

  expectTypeOf<RequestServices<typeof beside>>().toEqualTypeOf<Tenant>();

  const unbuilt = Authentication.layer(IdentityLogin, (token: Redacted.Redacted<string>) =>
    Effect.flatMap(Verifier, ({ verify }) => verify("acme", Redacted.value(token))),
  );

  expectTypeOf<Layer.Services<typeof unbuilt>>().toEqualTypeOf<
    HttpRouter.Request<"Requires", Verifier>
  >();

  const bearer = (token: Redacted.Redacted<string>) =>
    Effect.succeed({ id: Redacted.value(token) });

  const plain = Authentication.layer(IdentityLogin, bearer, {
    protectedResource: {
      resource: "https://api.example.com",
      authorizationServers: ["https://auth.example.com"],
    },
  });

  expectTypeOf<Layer.Error<typeof plain>>().toBeNever();
  expectTypeOf<Layer.Services<typeof plain>>().toEqualTypeOf<HttpRouter.HttpRouter>();

  const typedApart: Authentication.LayerOptions = {};
  const apart = Authentication.layer(IdentityLogin, bearer, typedApart);

  expectTypeOf<Layer.Services<typeof apart>>().toEqualTypeOf<HttpRouter.HttpRouter>();

  class Unconfigured extends Schema.TaggedError<Unconfigured>()("Unconfigured", {}) {}

  class Resources extends Context.Service<
    Resources,
    { readonly load: Effect.Effect<Authentication.ProtectedResource | undefined, Unconfigured> }
  >()("types/Resources") {}

  const startup = Authentication.layer(IdentityLogin, Effect.as(Verifier, bearer), {
    protectedResource: Effect.gen(function* () {
      const { load } = yield* Resources;
      yield* Effect.addFinalizer(() => Effect.void);

      return yield* load;
    }),
  });

  expectTypeOf<Layer.Services<typeof startup>>().toEqualTypeOf<
    HttpRouter.HttpRouter | Verifier | Resources
  >();
  expectTypeOf<Layer.Error<typeof startup>>().toEqualTypeOf<Unconfigured>();
};

export const voidSuccessTypes = () => {
  const Reset = Action.make("reset", {
    description: "Reset",
    readOnly: false,
    caller: Action.Anyone,
  });

  const Explicit = Action.make("explicit", {
    description: "Explicit",
    readOnly: false,
    caller: Action.Anyone,
    success: Schema.Void,
  });

  expectTypeOf<(typeof Reset)["success"]>().toEqualTypeOf<typeof Schema.Void>();

  Action.implement(Reset, () => Effect.void);
  Action.implement(Reset, () => Effect.succeed(undefined));
  Action.implement([Reset], { reset: () => Effect.void });
  Action.implement(
    Reset,
    Effect.succeed(() => Effect.void),
  );

  Action.implement(Reset, () => Effect.succeed("done"));
  Action.implement(Explicit, () => Effect.succeed(1));
};

export const mcpOptionTypes = (built: Action.Mcp, dangerous: boolean) => {
  const Write = Action.make("write", {
    description: "Every hint",
    readOnly: false,
    caller: Action.Anyone,
    mcp: { destructiveHint: false, idempotentHint: true, openWorldHint: false },
  });

  const Read = Action.make("read", {
    description: "A read's hints",
    readOnly: true,
    caller: Action.Anyone,
    mcp: { destructiveHint: false, idempotentHint: true, openWorldHint: false },
  });

  expectTypeOf<(typeof Write)["readOnly"]>().toEqualTypeOf<false>();
  expectTypeOf<(typeof Read)["readOnly"]>().toEqualTypeOf<true>();
  expectTypeOf<Extract<typeof Write | typeof Read, { readonly readOnly: true }>>().toEqualTypeOf<
    typeof Read
  >();

  Action.make("built", {
    description: "Options built ahead",
    readOnly: false,
    caller: Action.Anyone,
    mcp: built,
  });

  Action.make("typo", {
    description: "A misspelled hint",
    readOnly: false,
    caller: Action.Anyone,
    // @ts-expect-error -- A misspelled hint is refused beside a valid one, not silently ignored.
    mcp: { destructiveHint: false, idempotntHint: true },
  });

  Action.make("readOnly", {
    description: "A read-only hint",
    readOnly: false,
    caller: Action.Anyone,
    // @ts-expect-error -- A tool is read-only exactly when its action is, beside other hints too.
    mcp: { readOnlyHint: true, idempotentHint: true },
  });

  Action.make("short", {
    description: "A shorthand",
    readOnly: false,
    caller: Action.Anyone,
    // @ts-expect-error -- `destructive` is not MCP's name.
    mcp: { destructive: false },
  });

  const loose = { openWorldHint: false, idempotntHint: true };

  Action.make("loose", {
    description: "A misspelled hint built ahead",
    readOnly: true,
    caller: Action.Anyone,
    // @ts-expect-error -- A misspelled hint is refused in a value built ahead too.
    mcp: loose,
  });

  Action.make("spread", {
    description: "Hints spread by a condition",
    readOnly: false,
    caller: Action.Anyone,
    ...(dangerous ? { mcp: { destructiveHint: true, idempotentHint: true } } : {}),
  });

  // @ts-expect-error -- A misspelled hint in a conditional spread is refused too.
  Action.make("spreadTypo", {
    description: "A misspelled hint spread by a condition",
    readOnly: false,
    caller: Action.Anyone,
    ...(dangerous ? { mcp: { destructiveHint: true, idempotntHint: true } } : {}),
  });

  const valid = { idempotentHint: true };

  Action.make("chosenTypo", {
    description: "A misspelled hint in one branch",
    readOnly: false,
    caller: Action.Anyone,
    // @ts-expect-error -- A misspelled hint in either branch is refused.
    mcp: dangerous ? loose : valid,
  });

  const generic = <const H extends Action.Mcp>(mcp: H) =>
    Action.make("generic", {
      description: "Options of a type parameter",
      readOnly: false,
      caller: Action.Anyone,
      // @ts-expect-error -- Type 'H' is not assignable to type 'H & ...'.
      mcp,
    });

  const typed = (mcp: Action.Mcp) =>
    Action.make("typed", {
      description: "Options of a helper",
      readOnly: false,
      caller: Action.Anyone,
      mcp,
    });

  void generic;
  void typed;
};

export const servedRequirementTypes = () => {
  class Principal extends Context.Service<Principal, string>()("types-spec/Principal") {}

  const principal = () => Effect.map(Principal, (name) => name);

  const mcpApp = Action.implement(
    Action.make("act", {
      description: "A tool",
      readOnly: true,
      caller: Action.Anyone,
      success: Schema.String,
      mcp: { idempotentHint: true },
    }),
    principal,
  );

  Action.make("typo", {
    description: "Typo",
    readOnly: true,
    caller: Action.Anyone,
    success: Schema.String,
    // @ts-expect-error -- A misspelled option is an unknown property, not silently ignored.
    mpc: { idempotentHint: true },
  });

  expectTypeOf<(typeof mcpApp)["actions"][number]["mcp"]>().toEqualTypeOf<Action.Mcp>();

  Action.make("titled", {
    description: "Titled",
    readOnly: true,
    caller: Action.Anyone,
    mcp: { title: "Titled", _meta: { "ui/resourceUri": "ui://titled" } },
  });

  Action.make("titled", {
    description: "Titled",
    readOnly: true,
    caller: Action.Anyone,
    // @ts-expect-error -- A title is text.
    mcp: { title: 1 },
  });
};

export const mcpClientTypes = Effect.gen(function* () {
  const mcp = yield* Testing.mcpClient([Double, WhoAmI, GetUser]);
  const call = mcp.double({ value: 2 });

  expectTypeOf<typeof call>().toEqualTypeOf<
    Effect.Effect<
      number,
      Action.BuiltIn | Schema.SchemaError | HttpClientError.HttpClientError | Testing.McpCallError
    >
  >();

  expectTypeOf<
    Effect.Services<ReturnType<typeof Testing.mcpClient>>
  >().toEqualTypeOf<HttpClient.HttpClient>();

  // @ts-expect-error -- The input is the action's decoded input.
  void mcp.double({ value: "2" });
  expectTypeOf(
    Testing.mcpRequest("tools/list", { _meta: { progressToken: "p" } }),
  ).toEqualTypeOf<HttpClientRequest.HttpClientRequest>();

  yield* mcp.getUser({ id: "1" }).pipe(
    Effect.catchTag("UserNotFound", () => Effect.succeed(undefined)),
    Effect.catchTag("Forbidden", () => Effect.succeed(undefined)),
    Effect.catchTag("Unauthenticated", () => Effect.succeed(undefined)),
  );
});

export const maybeAbsentOptionTypes = (enabled: boolean) => {
  const Conditional = Action.make("conditional", {
    description: "Returns data only sometimes",
    readOnly: true,
    caller: Action.Anyone,
    success: enabled ? Schema.String : undefined,
  });

  const Spread = Action.make("spread", {
    description: "Returns data only sometimes",
    readOnly: true,
    caller: Action.Anyone,
    ...(enabled ? { success: Schema.String } : {}),
  });

  expectTypeOf<(typeof Conditional)["success"]["Type"]>().toEqualTypeOf<string | void>();
  expectTypeOf<(typeof Spread)["success"]["Type"]>().toEqualTypeOf<string | void>();

  class Session extends Context.Service<Session, string>()("types-spec/Session") {}

  const Who = Action.make("who", {
    description: "Who",
    readOnly: true,
    caller: CurrentActor,
    success: Schema.String,
  });

  const who = () => Effect.succeed("anyone");
  const authorize = () => Effect.asVoid(Session);

  const maybe = Action.implement(Who, who, { authorize: enabled ? authorize : Action.allowAll });

  const Http = ActionHttp.make([Who], { authentication: Login });

  expectTypeOf<
    RequestServices<ReturnType<typeof ActionHttp.layer<typeof Http, typeof maybe>>>
  >().toEqualTypeOf<Session>();
};

export const widenedOptionTypes = () => {
  const options: Parameters<typeof Action.make>[1] = {
    description: "Returns data",
    readOnly: true,
    caller: Action.Anyone,
    success: Schema.String,
  };

  const Widened = Action.make("widened", options);

  expectTypeOf<(typeof Widened)["success"]["Type"]>().toBeUnknown();
  expectTypeOf<(typeof Widened)["input"]["Type"]>().toBeUnknown();
  expectTypeOf<(typeof Widened)["error"]>().toExtend<Action.Any["error"]>();
  expectTypeOf<Action.Any["error"]>().toExtend<(typeof Widened)["error"]>();
  expectTypeOf<(typeof Widened)["caller"]>().toEqualTypeOf<
    typeof Action.Anyone | Context.Key<unknown, unknown>
  >();
};

export const unionOptionTypes = (
  options:
    | {
        readonly description: string;
        readonly readOnly: true;
        readonly caller: typeof Action.Anyone;
      }
    | {
        readonly description: string;
        readonly readOnly: true;
        readonly caller: typeof Action.Anyone;
        readonly input: { readonly id: typeof Schema.String };
        readonly success: typeof Schema.String;
        readonly error: [typeof Schema.Number];
      },
) => {
  const Either = Action.make("either", options);

  expectTypeOf<(typeof Either)["success"]["Type"]>().toEqualTypeOf<string | void>();
  expectTypeOf<(typeof Either)["input"]["Type"]>().toEqualTypeOf<
    { readonly id: string } | { readonly [x: string]: never }
  >();
  expectTypeOf<(typeof Either)["error"]>().toEqualTypeOf<ReadonlyArray<typeof Schema.Number>>();

  void Action.implement(Either, () => Effect.succeed("x"));
};

export const exportedTypes = (binding: ActionHttp.Any, app: Action.AnyImplementation) => {
  const options = {
    description: "Options built ahead of `make`",
    readOnly: true,
    caller: Action.Anyone,
  } satisfies Action.Options;

  const authorize: Action.Authorize<typeof Double> = (action) =>
    action.readOnly ? Effect.void : Effect.fail(new Action.Forbidden());

  const actionClientOptions: Action.ClientOptions<typeof Double> = { actions: [Double] };
  const layerOptions: ActionHttp.LayerOptions = { middleware: [] };

  const clientOptions: ActionHttp.ClientOptions = { baseUrl: "http://localhost" };
  const httpOptions: ActionMcp.LayerHttpOptions = { name: "test", version: "0" };
  const serverOptions: ActionMcp.Options = { name: "test", version: "0" };
  const shared: ActionMcp.LayerHttpOptions = serverOptions;
  const call: Testing.McpClientOptions = { url: "/mcp" };
  const request: Testing.McpRequestOptions = { url: "/mcp", headers: {} };
  const params: Testing.McpParams = { name: "double", _meta: { progressToken: "p" } };

  expectTypeOf<Parameters<typeof Testing.mcpRequest>[1]>().toEqualTypeOf<
    Testing.McpParams | undefined
  >();

  const auth: Authentication.ProtectedResource = {
    resource: "https://api.example.com/mcp",
    authorizationServers: ["https://auth.example.com"],
  };

  const authenticationOptions: Authentication.LayerOptions = { protectedResource: auth };

  const verifiers: Authentication.Verify<string, typeof Login.security, never> = (token) =>
    Effect.succeed(Redacted.value(token));

  const given = Action.make("given", { ...options, input: {} });
  expectTypeOf<(typeof given)["input"]>().toEqualTypeOf<(typeof WhoAmI)["input"]>();
  const struct = Action.make("struct", { ...options, input: Schema.Struct({}) });
  expectTypeOf<(typeof struct)["input"]>().toEqualTypeOf<Schema.Struct<{}>>();

  void [binding, app, authorize, clientOptions, httpOptions, call, request, params, auth, shared];
  void [actionClientOptions, layerOptions, authenticationOptions, verifiers];
};

{
  const Profile = Action.make("profile", {
    description: "The caller's id",
    readOnly: true,
    caller: Action.Anyone,
    success: Schema.String,
  });

  const binding = ActionHttp.make([Profile]);

  type DefaultReadOnly = Action.Action<
    "profile",
    typeof Profile.input,
    typeof Profile.success,
    typeof Profile.error,
    boolean,
    typeof Action.Anyone
  >;

  type WiderSuccess = Action.Action<
    "profile",
    typeof Profile.input,
    Schema.Codec<string>,
    typeof Profile.error,
    true,
    typeof Action.Anyone
  >;

  const read = () => Effect.map(CurrentActor, ({ id }) => id);

  const defaultReadOnly = (action: DefaultReadOnly) => Action.implement(action, read);
  const widerSuccess = (action: WiderSuccess) => Action.implement(action, read);

  const servedDefault = ActionHttp.layer(binding, defaultReadOnly(Profile));
  const servedWider = ActionHttp.layer(binding, widerSuccess(Profile));

  expectTypeOf<
    Extract<Layer.Services<typeof servedDefault>, HttpRouter.Request<"Requires", unknown>>
  >().toEqualTypeOf<HttpRouter.Request<"Requires", CurrentActor>>();

  expectTypeOf<
    Extract<Layer.Services<typeof servedWider>, HttpRouter.Request<"Requires", unknown>>
  >().toEqualTypeOf<HttpRouter.Request<"Requires", CurrentActor>>();
}

{
  class AgentStore extends Context.Service<AgentStore, string>()("types/AgentStore") {}

  const Search = Action.make("search", {
    description: "Search the site",
    readOnly: true,
    caller: Action.Anyone,
    input: { query: Schema.String },
    success: Schema.String,
  });

  const AgentSearch = Action.make("search", {
    description: "Search the agent's notes",
    readOnly: true,
    caller: Action.Anyone,
    input: { topic: Schema.String },
    success: Schema.String,
  });

  const Ping = Action.make("ping", { description: "Ping", readOnly: true, caller: Action.Anyone });

  const web = Action.implement(Search, ({ query }) => Effect.succeed(query));

  const agent = Action.implement([Ping, AgentSearch], {
    ping: () => Effect.void,
    search: () => Effect.service(AgentStore),
  });

  const served = ActionHttp.layer(ActionHttp.make([Search, Ping]), [web, agent]);

  expectTypeOf<
    Extract<Layer.Services<typeof served>, HttpRouter.Request<"Requires", unknown>>
  >().toBeNever();
}

{
  const Profile = Action.make("profile", {
    description: "",
    readOnly: true,
    caller: Action.Anyone,
  });

  const app = Action.implement(Profile, () => Effect.asVoid(CurrentActor));

  const annotated: Action.Implementation<
    Action.Action<
      "profile" | "audit",
      typeof Profile.input,
      typeof Profile.success,
      typeof Profile.error,
      true,
      typeof Action.Anyone
    >,
    (typeof app)["~request"],
    never,
    never
  > = app;

  const served = ActionHttp.layer(ActionHttp.make([Profile]), annotated);

  expectTypeOf<
    Extract<Layer.Services<typeof served>, HttpRouter.Request<"Requires", unknown>>
  >().toEqualTypeOf<HttpRouter.Request<"Requires", CurrentActor>>();
}
