// Compile-only assertions, included by `vp check`, on RPC bindings, their layers' requirements
// and middleware, and their clients' methods.
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
import * as Action from "../src/Action.js";
import * as ActionRpc from "../src/ActionRpc.js";
import * as Authentication from "../src/Authentication.js";

class Actor extends Context.Service<Actor, string>()("rpc-types/Actor") {}

class Tenant extends Context.Service<Tenant, string>()("rpc-types/Tenant") {}

/** What only the handlers' builder reads, at startup. */
class Clock extends Context.Service<Clock, number>()("rpc-types/Clock") {}

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
  Effect.as(Clock, {
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

// A binding holding a protected action names its descriptor; one of public actions needs none.
// @ts-expect-error Protected actions take options naming their authentication.
ActionRpc.make([Open, Get]);

ActionRpc.make([Open]);

// @ts-expect-error The descriptor authenticates another identity.
ActionRpc.make([Get], { authentication: Authentication.make("rpc-types.Other", Tenant) });

// @ts-expect-error No option `prefix`: an RPC binding mounts nowhere.
ActionRpc.make([Open], { prefix: "/rpc" });

// The binding's errors, one schema or a list, are a list.
expectTypeOf(ActionRpc.make([Open], { error: Throttled }).error).toEqualTypeOf<
  readonly [typeof Throttled]
>();

expectTypeOf(ActionRpc.make([Open], { error: [Throttled, Unavailable] }).error).toEqualTypeOf<
  readonly [typeof Throttled, typeof Unavailable]
>();

expectTypeOf(Rpc.error).toEqualTypeOf<[]>();

// The native group: a native client's method per action, its payload the action's input.
type Native = RpcClient.FromGroup<typeof Rpc.group, RpcClientError.RpcClientError>;

expectTypeOf<Parameters<Native["get"]>[0]>().toEqualTypeOf<{ readonly id: string }>();

expectTypeOf<Effect.Error<ReturnType<Native["get"]>>>().toEqualTypeOf<
  | Missing
  | Action.InvalidInput
  | Action.Unauthenticated
  | Action.Forbidden
  | RpcClientError.RpcClientError
>();

/** What every call may fail with besides the action's and the binding's own errors. */
type BuiltIn =
  | Action.InvalidInput
  | Action.Unauthenticated
  | Action.Forbidden
  | RpcClientError.RpcClientError;

const made = ActionRpc.client(Rpc);

// The client needs the native client protocol, in a scope, as `RpcClient.make`.
expectTypeOf<Effect.Services<typeof made>>().toEqualTypeOf<RpcClient.Protocol | Scope.Scope>();

export const clientTypes = Effect.gen(function* () {
  const client = yield* made;

  // The input of an action without one may be left out; another's is required.
  const open = client.open();

  // @ts-expect-error `get` takes its input.
  client.get();

  const get = client.get({ id: "1" });

  expectTypeOf<Effect.Success<typeof get>>().toEqualTypeOf<string>();
  expectTypeOf<Effect.Error<typeof get>>().toEqualTypeOf<Missing | BuiltIn>();
  expectTypeOf<Effect.Error<typeof open>>().toEqualTypeOf<BuiltIn>();
  expectTypeOf<Effect.Services<typeof get>>().toBeNever();

  // A protected method may fail with its descriptor's error, a public one never.
  const checked = yield* ActionRpc.client(
    ActionRpc.make([Open, Get], { authentication: Checked, error: Throttled }),
  );

  expectTypeOf<Effect.Error<ReturnType<typeof checked.get>>>().toEqualTypeOf<
    Missing | Throttled | Unavailable | BuiltIn
  >();

  expectTypeOf<Effect.Error<ReturnType<typeof checked.open>>>().toEqualTypeOf<
    Throttled | BuiltIn
  >();

  // The client type is nameable from the binding.
  expectTypeOf(client).toEqualTypeOf<ActionRpc.Client<typeof Rpc>>();
});

/** What a layer owes per request, as router request markers. */
type Owed<L extends Layer.Any> = HttpRouter.Request.Only<"Requires", Layer.Services<L>>;

/** What a layer owes otherwise. */
type Startup<L extends Layer.Any> = HttpRouter.Request.Without<Layer.Services<L>>;

const served = ActionRpc.layer(Rpc, app);

// The protocol, never a serialization, which the protocol needs if it does; the builder's
// services, and the provider of the protected action's descriptor; per request, the public
// handler's Tenant, never the identity.
expectTypeOf<Startup<typeof served>>().toEqualTypeOf<
  RpcServer.Protocol | Clock | Authentication.Provider<Actor, "rpc-types.Login">
>();

expectTypeOf<Owed<typeof served>>().toEqualTypeOf<Tenant>();

// Narrowed by `actions`: serving only the public action owes no provider.
const open = ActionRpc.layer(Rpc, app, { actions: [Open] });

expectTypeOf<Startup<typeof open>>().toEqualTypeOf<RpcServer.Protocol | Clock>();

// Serving only the protected one owes no Tenant.
const guarded = ActionRpc.layer(Rpc, app, { actions: [Get] });

expectTypeOf<Owed<typeof guarded>>().toBeNever();

// @ts-expect-error Listed actions are the binding's.
ActionRpc.layer(ActionRpc.make([Open]), app, { actions: [Get] });

// @ts-expect-error No option `actons`.
ActionRpc.layer(Rpc, app, { actons: [Open] });

// A startup Tenant does not provide a request's.
const startup = served.pipe(Layer.provide(Layer.succeed(Tenant, "startup")));

expectTypeOf<Owed<typeof startup>>().toEqualTypeOf<Tenant>();

/** Provides each message's tenant. */
class ResolveTenant extends RpcMiddleware.Service<ResolveTenant, { provides: Tenant }>()(
  "rpc-types/ResolveTenant",
) {}

/** Requires the tenant. */
class NeedsTenant extends RpcMiddleware.Service<NeedsTenant, { requires: Tenant }>()(
  "rpc-types/NeedsTenant",
) {}

/** Requires the identity, which only authentication provides. */
class NeedsActor extends RpcMiddleware.Service<NeedsActor, { requires: Actor }>()(
  "rpc-types/NeedsActor",
) {}

/** Fails with what the binding may declare. */
class Limit extends RpcMiddleware.Service<Limit>()("rpc-types/Limit", { error: Throttled }) {}

/** Fails with an error of its own. */
class Fails extends RpcMiddleware.Service<Fails>()("rpc-types/Fails", { error: Schema.String }) {}

/** Needs a client counterpart. */
class ForClient extends RpcMiddleware.Service<ForClient>()("rpc-types/ForClient", {
  requiredForClient: true,
}) {}

// A middleware providing a request service discharges it, and the layer owes the middleware.
const tenanted = ActionRpc.layer(Rpc, app, { middleware: [ResolveTenant] });

expectTypeOf<Owed<typeof tenanted>>().toBeNever();

expectTypeOf<ResolveTenant>().toExtend<Startup<typeof tenanted>>();

// The first listed is innermost: an outer one provides what an inner one requires.
const inner = ActionRpc.layer(Rpc, app, { middleware: [NeedsTenant, ResolveTenant] });

expectTypeOf<Owed<typeof inner>>().toBeNever();

const outer = ActionRpc.layer(Rpc, app, { middleware: [ResolveTenant, NeedsTenant] });

expectTypeOf<Owed<typeof outer>>().toEqualTypeOf<Tenant>();

// The identity is provided to middleware only where every served action is protected.
const mixed = ActionRpc.layer(Rpc, app, { middleware: [NeedsActor, ResolveTenant] });

expectTypeOf<Owed<typeof mixed>>().toEqualTypeOf<Actor>();

const protectedOnly = ActionRpc.layer(Rpc, app, { actions: [Get], middleware: [NeedsActor] });

expectTypeOf<Owed<typeof protectedOnly>>().toBeNever();

// A middleware fails only with the binding's errors or a built-in one, and needs no client.
// @ts-expect-error Layer middleware fails only with the binding's errors.
ActionRpc.layer(Rpc, app, { middleware: [Limit] });

ActionRpc.layer(ActionRpc.make([Open, Get], { authentication: Login, error: Throttled }), app, {
  middleware: [Limit],
});

// @ts-expect-error Undeclared by every binding.
ActionRpc.layer(ActionRpc.make([Open], { error: Throttled }), app, { middleware: [Fails] });

// @ts-expect-error A middleware needing a client counterpart reaches no client of the binding.
ActionRpc.layer(Rpc, app, { middleware: [ForClient] });

// A fully provided layer, served over a protocol the host provides.
export const provided = ActionRpc.layer(Rpc, app, { middleware: [ResolveTenant] }).pipe(
  Layer.provide(
    Layer.succeed(ResolveTenant, (effect) => Effect.provideService(effect, Tenant, "t")),
  ),
  Layer.provide(RpcServer.layerProtocolHttp({ path: "/rpc" })),
  Layer.provide(RpcSerialization.layerJson),
  Layer.provide(Authentication.layer(Login, verify)),
  Layer.provide(Layer.succeed(Clock, 0)),
);

expectTypeOf<Layer.Services<typeof provided>>().toEqualTypeOf<HttpRouter.HttpRouter>();

// The native client of the binding's group stays available.
export const native = RpcClient.make(Rpc.group);
