import { Context, Effect, type Layer, Schema, Stream } from "effect";
import { expectTypeOf } from "@effect/vitest";
import type { HttpRouter } from "effect/http";
import { type RpcClientError, RpcMiddleware } from "effect/rpc";
import * as Action from "../../src/contract/Action.js";
import * as Authentication from "../../src/authentication/Authentication.js";
import * as Event from "../../src/contract/Event.js";
import * as ActionRpc from "../../src/rpc/ActionRpc.js";

class Caller extends Context.Service<Caller, string>()("rpc-events-types/Caller") {}

class Store extends Context.Service<Store, string>()("rpc-events-types/Store") {}

class Region extends Context.Service<Region, string>()("rpc-events-types/Region") {}

class Quota extends Schema.TaggedError<Quota>()("Quota", {}) {}

const Login = Authentication.make("rpc-events-types.Login", Caller);

const Watched = Event.make("account.watched", {
  description: "",
  input: { id: Schema.String },
  payload: { by: Schema.String },
  caller: Caller,
});

const Ticked = Event.make("clock.ticked", {
  description: "",
  payload: { at: Schema.Finite },
  caller: Action.Anyone,
});

const Open = Action.make("open", { description: "", readOnly: true, caller: Action.Anyone });

const watched = Event.implement(
  Watched,
  Effect.as(Store, {
    check: () => Effect.as(Region, { cursor: "0", events: [] }),
  }),
  { authorize: Event.allowAll },
);

const ticks = Event.implement(Ticked, { log: { emit: Stream.never } });

const opened = Action.implement(Open, () => Effect.void);

const Rpc = ActionRpc.make([Open, Watched, Ticked], { authentication: Login, error: [Quota] });

expectTypeOf(Rpc.actions).toEqualTypeOf<ReadonlyArray<typeof Open>>();

expectTypeOf(Rpc.events).toEqualTypeOf<ReadonlyArray<typeof Watched | typeof Ticked>>();

// @ts-expect-error -- A protected event is bound only with authentication.
ActionRpc.make([Watched]);

const served = ActionRpc.layer(Rpc, [opened, watched, ticks]);

expectTypeOf<
  HttpRouter.Request.Only<"Requires", Layer.Services<typeof served>>
>().toEqualTypeOf<Region>();

expectTypeOf<Store | Authentication.Provider<Caller, "rpc-events-types.Login">>().toExtend<
  Layer.Services<typeof served>
>();

export const watchOverRpc = Effect.gen(function* () {
  const rpc = yield* ActionRpc.client(Rpc);
  const watching = rpc.watch(Watched, { id: "a" });

  expectTypeOf<Stream.Success<typeof watching>>().toEqualTypeOf<Event.Received<typeof Watched>>();
  expectTypeOf<Stream.Error<typeof watching>>().toEqualTypeOf<
    | Event.SubscriptionError
    | Action.InvalidInput
    | Action.Unauthenticated
    | Action.Forbidden
    | Quota
    | RpcClientError.RpcClientError
  >();
  expectTypeOf<Stream.Services<typeof watching>>().toBeNever();

  // @ts-expect-error -- Its input is the event's.
  void rpc.watch(Watched, { id: 1 });
  // @ts-expect-error -- Only the binding's events.
  void rpc.watch(Event.make("x.y", { description: "", payload: {}, caller: Action.Anyone }));

  // @ts-expect-error -- A binding listing no event type has no `watch`.
  void (yield* ActionRpc.client(ActionRpc.make([Open]))).watch;
});

class ResolveRegion extends RpcMiddleware.Service<ResolveRegion, { provides: Region }>()(
  "rpc-events-types/ResolveRegion",
) {}

const readingBoth = Event.implement(
  Watched,
  {
    check: () => Effect.flatMap(Caller, () => Effect.as(Region, { cursor: "0", events: [] })),
    key: () => Region,
  },
  { authorize: Event.allowAll },
);

const servedThroughMiddleware = ActionRpc.layer(Rpc, [opened, readingBoth], {
  middleware: [ResolveRegion],
});

expectTypeOf<
  HttpRouter.Request.Only<"Requires", Layer.Services<typeof servedThroughMiddleware>>
>().toBeNever();
