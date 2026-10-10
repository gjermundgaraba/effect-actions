import { Context, Effect, Layer, Redacted, Schema, type Scope } from "effect";
import type { HttpRouter } from "effect/http";
import {
  RpcClient,
  type RpcClientError,
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
