import { Context, Effect, Layer, Redacted, Schema, type Scope, Stream } from "effect";
import type { HttpRouter } from "effect/http";
import {
  Rpc as NativeRpc,
  RpcClient,
  type RpcClientError,
  RpcGroup,
  RpcMiddleware,
  RpcSerialization,
  RpcServer,
} from "effect/rpc";
import { expectTypeOf } from "@effect/vitest";
import * as Action from "../../src/contract/Action.js";
import * as ActionRpc from "../../src/rpc/ActionRpc.js";
import * as Authentication from "../../src/authentication/Authentication.js";

class Actor extends Context.Service<Actor, string>()("rpc-types/Actor") {}

class Tenant extends Context.Service<Tenant, string>()("rpc-types/Tenant") {}

class BuilderClock extends Context.Service<BuilderClock, number>()("rpc-types/Clock") {}

class Missing extends Schema.TaggedError<Missing>()("Missing", { id: Schema.String }) {}

class Throttled extends Schema.TaggedError<Throttled>()("Throttled", {}) {}

class Unavailable extends Schema.TaggedError<Unavailable>()("Unavailable", {}) {}

const Open = Action.make("open", {
  description: "Answer anyone, in the request's tenant",
  readOnly: true,
  caller: Action.Anyone,
  success: Schema.String,
});

const Get = Action.make("get", {
  description: "Read a note",
  readOnly: true,
  caller: Actor,
  input: { id: Schema.String },
  success: Schema.String,
  error: Missing,
});

const app = Action.implement(
  [Open, Get],
  Effect.as(BuilderClock, {
    open: () => Tenant,
    get: ({ id }: { readonly id: string }) =>
      Effect.flatMap(Actor, (actor) => Effect.succeed(`${actor}:${id}`)),
  }),
  { authorize: Action.allowAll },
);

const Login = Authentication.make("rpc-types.Login", Actor);

const Checked = Authentication.make("rpc-types.Checked", Actor, { error: Unavailable });

const verify = (token: Redacted.Redacted<string>) => Effect.succeed(Redacted.value(token));

const Rpc = ActionRpc.make([Open, Get], { authentication: Login });

// @ts-expect-error -- Protected actions take options naming their authentication.
ActionRpc.make([Open, Get]);

ActionRpc.make([Open]);

// @ts-expect-error -- The descriptor authenticates another identity.
ActionRpc.make([Get], { authentication: Authentication.make("rpc-types.Other", Tenant) });

// @ts-expect-error -- No option `prefix`: an RPC binding mounts nowhere.
ActionRpc.make([Open], { prefix: "/rpc" });

expectTypeOf(ActionRpc.make([Open], { error: Throttled }).error).toEqualTypeOf<
  readonly [typeof Throttled]
>();

expectTypeOf(ActionRpc.make([Open], { error: [Throttled, Unavailable] }).error).toEqualTypeOf<
  readonly [typeof Throttled, typeof Unavailable]
>();

expectTypeOf(Rpc.error).toEqualTypeOf<[]>();

type NativeClientOfGroup = RpcClient.FromGroup<typeof Rpc.group, RpcClientError.RpcClientError>;

expectTypeOf<Parameters<NativeClientOfGroup["get"]>[0]>().toEqualTypeOf<{ readonly id: string }>();

expectTypeOf<Effect.Error<ReturnType<NativeClientOfGroup["get"]>>>().toEqualTypeOf<
  | Missing
  | Action.InvalidInput
  | Action.Unauthenticated
  | Action.Forbidden
  | RpcClientError.RpcClientError
>();

type EveryCallFailure =
  | Action.InvalidInput
  | Action.Unauthenticated
  | Action.Forbidden
  | RpcClientError.RpcClientError;

const made = ActionRpc.client(Rpc);

expectTypeOf<Effect.Services<typeof made>>().toEqualTypeOf<RpcClient.Protocol | Scope.Scope>();

export const clientTypes = Effect.gen(function* () {
  const client = yield* made;

  const open = client.open();

  // @ts-expect-error -- `get` takes its input.
  client.get();

  const get = client.get({ id: "1" });

  expectTypeOf<Effect.Success<typeof get>>().toEqualTypeOf<string>();
  expectTypeOf<Effect.Error<typeof get>>().toEqualTypeOf<Missing | EveryCallFailure>();
  expectTypeOf<Effect.Error<typeof open>>().toEqualTypeOf<EveryCallFailure>();
  expectTypeOf<Effect.Services<typeof get>>().toBeNever();

  const checked = yield* ActionRpc.client(
    ActionRpc.make([Open, Get], { authentication: Checked, error: Throttled }),
  );

  expectTypeOf<Effect.Error<ReturnType<typeof checked.get>>>().toEqualTypeOf<
    Missing | Throttled | Unavailable | EveryCallFailure
  >();

  expectTypeOf<Effect.Error<ReturnType<typeof checked.open>>>().toEqualTypeOf<
    Throttled | EveryCallFailure
  >();

  expectTypeOf(client).toEqualTypeOf<ActionRpc.Client<typeof Rpc>>();
});

type OwedPerRequest<L extends Layer.Any> = HttpRouter.Request.Only<"Requires", Layer.Services<L>>;

type OwedAtStartup<L extends Layer.Any> = HttpRouter.Request.Without<Layer.Services<L>>;

const served = ActionRpc.layer(Rpc, app);

expectTypeOf<OwedAtStartup<typeof served>>().toEqualTypeOf<
  RpcServer.Protocol | BuilderClock | Authentication.Provider<Actor, "rpc-types.Login">
>();

expectTypeOf<OwedPerRequest<typeof served>>().toEqualTypeOf<Tenant>();

const publicOnlyOwesNoProvider = ActionRpc.layer(Rpc, app, { actions: [Open] });

expectTypeOf<OwedAtStartup<typeof publicOnlyOwesNoProvider>>().toEqualTypeOf<
  RpcServer.Protocol | BuilderClock
>();

const protectedOnlyOwesNoTenant = ActionRpc.layer(Rpc, app, { actions: [Get] });

expectTypeOf<OwedPerRequest<typeof protectedOnlyOwesNoTenant>>().toBeNever();

// @ts-expect-error -- Listed actions are the binding's.
ActionRpc.layer(ActionRpc.make([Open]), app, { actions: [Get] });

// @ts-expect-error -- No option `actons`.
ActionRpc.layer(Rpc, app, { actons: [Open] });

const startupTenantLeavesRequestOwed = served.pipe(Layer.provide(Layer.succeed(Tenant, "startup")));

expectTypeOf<OwedPerRequest<typeof startupTenantLeavesRequestOwed>>().toEqualTypeOf<Tenant>();

class ResolveTenant extends RpcMiddleware.Service<ResolveTenant, { provides: Tenant }>()(
  "rpc-types/ResolveTenant",
) {}

class NeedsTenant extends RpcMiddleware.Service<NeedsTenant, { requires: Tenant }>()(
  "rpc-types/NeedsTenant",
) {}

class NeedsActor extends RpcMiddleware.Service<NeedsActor, { requires: Actor }>()(
  "rpc-types/NeedsActor",
) {}

class ThrottlingLimit extends RpcMiddleware.Service<ThrottlingLimit>()("rpc-types/Limit", {
  error: Throttled,
}) {}

class Fails extends RpcMiddleware.Service<Fails>()("rpc-types/Fails", { error: Schema.String }) {}

class ForClient extends RpcMiddleware.Service<ForClient>()("rpc-types/ForClient", {
  requiredForClient: true,
}) {}

const tenanted = ActionRpc.layer(Rpc, app, { middleware: [ResolveTenant] });

expectTypeOf<OwedPerRequest<typeof tenanted>>().toBeNever();

expectTypeOf<ResolveTenant>().toExtend<OwedAtStartup<typeof tenanted>>();

const innerNeedsTenant = ActionRpc.layer(Rpc, app, { middleware: [NeedsTenant, ResolveTenant] });

expectTypeOf<OwedPerRequest<typeof innerNeedsTenant>>().toBeNever();

const outerNeedsTenant = ActionRpc.layer(Rpc, app, { middleware: [ResolveTenant, NeedsTenant] });

expectTypeOf<OwedPerRequest<typeof outerNeedsTenant>>().toEqualTypeOf<Tenant>();

const mixedActionsOweActor = ActionRpc.layer(Rpc, app, { middleware: [NeedsActor, ResolveTenant] });

expectTypeOf<OwedPerRequest<typeof mixedActionsOweActor>>().toEqualTypeOf<Actor>();

const protectedOnly = ActionRpc.layer(Rpc, app, { actions: [Get], middleware: [NeedsActor] });

expectTypeOf<OwedPerRequest<typeof protectedOnly>>().toBeNever();

// @ts-expect-error -- Layer middleware fails only with the binding's errors.
ActionRpc.layer(Rpc, app, { middleware: [ThrottlingLimit] });

ActionRpc.layer(ActionRpc.make([Open, Get], { authentication: Login, error: Throttled }), app, {
  middleware: [ThrottlingLimit],
});

// @ts-expect-error -- Undeclared by every binding.
ActionRpc.layer(ActionRpc.make([Open], { error: Throttled }), app, { middleware: [Fails] });

// @ts-expect-error -- A middleware needing a client counterpart reaches no client of the binding.
ActionRpc.layer(Rpc, app, { middleware: [ForClient] });

class Region extends Context.Service<Region, string>()("rpc-types/Region") {}

class NeedsRegion extends RpcMiddleware.Service<NeedsRegion, { requires: Region }>()(
  "rpc-types/NeedsRegion",
) {}

class GivesRegion extends RpcMiddleware.Service<GivesRegion, { provides: Region }>()(
  "rpc-types/GivesRegion",
) {}

class Logged extends RpcMiddleware.Service<Logged>()("rpc-types/Logged") {}

const outerGivesRegion = ActionRpc.layer(Rpc, app, { middleware: [NeedsRegion, GivesRegion] });

expectTypeOf<OwedPerRequest<typeof outerGivesRegion>>().toEqualTypeOf<Tenant>();

// @ts-expect-error -- Explicit options naming middleware require the options, which alone install it.
ActionRpc.layer<typeof Rpc, typeof app, { readonly middleware: [typeof GivesRegion] }>(Rpc, app);

const shared: ReadonlyArray<typeof NeedsRegion | typeof GivesRegion> = [NeedsRegion, GivesRegion];

const unknownOrderOwesAny = ActionRpc.layer(Rpc, app, { middleware: shared });

expectTypeOf<OwedPerRequest<typeof unknownOrderOwesAny>>().toEqualTypeOf<Tenant | Region>();

const maybeGiven: ActionRpc.LayerOptions<[typeof NeedsRegion, typeof GivesRegion]> = {};

const maybeAbsentMiddleware = ActionRpc.layer(Rpc, app, maybeGiven);

expectTypeOf<OwedPerRequest<typeof maybeAbsentMiddleware>>().toEqualTypeOf<Tenant | Region>();

declare const regional: boolean;

const conditionallyGiven = ActionRpc.layer(
  Rpc,
  app,
  regional ? { middleware: [NeedsRegion, GivesRegion] } : {},
);

expectTypeOf<OwedPerRequest<typeof conditionallyGiven>>().toEqualTypeOf<Tenant | Region>();

expectTypeOf<GivesRegion>().toExtend<Layer.Services<typeof conditionallyGiven>>();

const slotOfSeveralProvidesNothing = ActionRpc.layer(Rpc, app, {
  middleware: [NeedsRegion, regional ? GivesRegion : Logged],
});

expectTypeOf<OwedPerRequest<typeof slotOfSeveralProvidesNothing>>().toEqualTypeOf<
  Tenant | Region
>();

const maybeAbsentErrors: ActionRpc.Options<readonly [typeof Throttled]> & {
  readonly authentication: typeof Login;
} = { authentication: Login };

const Unsure = ActionRpc.make([Get], maybeAbsentErrors);

expectTypeOf(Unsure.error).toEqualTypeOf<readonly [typeof Throttled] | []>();

// @ts-expect-error -- Options that may leave `errors` out may declare none, so the error is undeclared.
ActionRpc.layer(Unsure, app, { middleware: [ThrottlingLimit] });

const unsized: Array<typeof Throttled> = [];

const either: readonly [typeof Throttled | typeof Unavailable] = [Unavailable];

const extra: ReadonlyArray<typeof Unavailable> = [];

const Unsized = ActionRpc.make([Get], { authentication: Login, error: unsized });

const Either = ActionRpc.make([Get], { authentication: Login, error: either });

const Variadic = ActionRpc.make([Get], { authentication: Login, error: [Throttled, ...extra] });

// @ts-expect-error -- Not surely declared by this binding.
ActionRpc.layer(Unsized, app, { middleware: [ThrottlingLimit] });

// @ts-expect-error -- Not surely declared by this binding.
ActionRpc.layer(Either, app, { middleware: [ThrottlingLimit] });

// @ts-expect-error -- Not surely declared by this binding.
ActionRpc.layer(Variadic, app, { middleware: [ThrottlingLimit] });

class BuiltInFailingAllowlist extends RpcMiddleware.Service<BuiltInFailingAllowlist>()(
  "rpc-types/Allowlist",
  { error: Action.Forbidden },
) {}

ActionRpc.layer(Rpc, app, { middleware: [BuiltInFailingAllowlist] });

export const fullyProvidedOverHostProtocol = ActionRpc.layer(Rpc, app, {
  middleware: [ResolveTenant],
}).pipe(
  Layer.provide(
    Layer.succeed(ResolveTenant, (effect) => Effect.provideService(effect, Tenant, "t")),
  ),
  Layer.provide(RpcServer.layerProtocolHttp({ path: "/rpc" })),
  Layer.provide(RpcSerialization.layerJson),
  Layer.provide(Authentication.layer(Login, verify)),
  Layer.provide(Layer.succeed(BuilderClock, 0)),
);

expectTypeOf<
  Layer.Services<typeof fullyProvidedOverHostProtocol>
>().toEqualTypeOf<HttpRouter.HttpRouter>();

export const nativeClientOfGroup = RpcClient.make(Rpc.group);

const Watch = NativeRpc.make("watch", {
  payload: { after: Schema.Int },
  success: Schema.String,
  stream: true,
});

const Watched = ActionRpc.make([Open, Get], {
  authentication: Checked,
  rpcs: RpcGroup.make(Watch),
});

export const watchedClient = Effect.gen(function* () {
  const client = yield* ActionRpc.client(Watched);

  const watching = client.watch({ after: 0 });

  expectTypeOf(watching).toEqualTypeOf<
    Stream.Stream<string, Action.Unauthenticated | Unavailable | RpcClientError.RpcClientError>
  >();

  // @ts-expect-error -- `watch` takes its payload.
  client.watch();

  expectTypeOf<Effect.Error<ReturnType<typeof client.get>>>().toEqualTypeOf<
    Missing | Unavailable | EveryCallFailure
  >();
});

expectTypeOf<Effect.Services<ReturnType<typeof ActionRpc.client<typeof Watched>>>>().toEqualTypeOf<
  RpcClient.Protocol | Scope.Scope
>();

const watchingWithTheIdentity = Watched.rpcs.toLayer({
  watch: ({ after }) =>
    Stream.unwrap(Effect.map(Actor, (actor) => Stream.make(`${actor}:${after}`))),
});

expectTypeOf<Layer.Services<typeof watchingWithTheIdentity>>().toBeNever();

const unwatched = ActionRpc.layer(Watched, app);

expectTypeOf<NativeRpc.Handler<"watch">>().toExtend<Layer.Services<typeof unwatched>>();

export const servedWithHandlers = ActionRpc.layer(Watched, app).pipe(
  Layer.provide(watchingWithTheIdentity),
  Layer.provide(RpcServer.layerProtocolHttp({ path: "/rpc" })),
  Layer.provide(RpcSerialization.layerJson),
  Layer.provide(Authentication.layer(Checked, verify)),
  Layer.provide(Layer.succeed(BuilderClock, 0)),
);

type HostOwed = HttpRouter.HttpRouter | HttpRouter.Request<"Requires", Tenant>;

expectTypeOf<Layer.Services<typeof servedWithHandlers>>().toEqualTypeOf<HostOwed>();

// @ts-expect-error -- The layer requires the native rpcs' handlers.
export const servedWithoutHandlers: Layer.Layer<never, never, HostOwed> = ActionRpc.layer(
  Watched,
  app,
).pipe(
  Layer.provide(RpcServer.layerProtocolHttp({ path: "/rpc" })),
  Layer.provide(RpcSerialization.layerJson),
  Layer.provide(Authentication.layer(Checked, verify)),
  Layer.provide(Layer.succeed(BuilderClock, 0)),
);

class Denied extends Schema.TaggedError<Denied>()("Denied", {}) {}

class Gate extends RpcMiddleware.Service<Gate>()("rpc-types/Gate", {
  error: Schema.Union([Denied]),
}) {}

const Gated = ActionRpc.make([], { rpcs: RpcGroup.make(NativeRpc.make("one")).middleware(Gate) });

const gatedUnprovided = ActionRpc.layer(Gated, []).pipe(
  Layer.provide(Gated.rpcs.toLayer({ one: () => Effect.void })),
);

expectTypeOf<Layer.Services<typeof gatedUnprovided>>().toEqualTypeOf<RpcServer.Protocol | Gate>();

const GatedWatch = ActionRpc.make([Open, Get], {
  authentication: Checked,
  rpcs: RpcGroup.make(Watch).middleware(Gate),
});

const gatedWatchUnprovided = ActionRpc.layer(GatedWatch, app).pipe(
  Layer.provide(
    GatedWatch.rpcs.toLayer({
      watch: ({ after }) =>
        Stream.unwrap(Effect.map(Actor, (actor) => Stream.make(`${actor}:${after}`))),
    }),
  ),
  Layer.provide(RpcServer.layerProtocolHttp({ path: "/rpc" })),
  Layer.provide(RpcSerialization.layerJson),
  Layer.provide(Authentication.layer(Checked, verify)),
  Layer.provide(Layer.succeed(BuilderClock, 0)),
);

expectTypeOf<Layer.Services<typeof gatedWatchUnprovided>>().toEqualTypeOf<HostOwed | Gate>();
