import { Effect, type Layer, Stream } from "effect";
import { expectTypeOf } from "@effect/vitest";
import type { HttpRouter } from "effect/http";
import { type RpcClientError, RpcMiddleware } from "effect/rpc";
import * as Action from "../../src/contract/Action.js";
import type * as Authentication from "../../src/authentication/Authentication.js";
import * as Event from "../../src/contract/Event.js";
import * as ActionRpc from "../../src/rpc/ActionRpc.js";
import {
  type Caller,
  Login,
  Open,
  opened,
  type Quota,
  Quota as QuotaError,
  readingBoth,
  type Region,
  type Store,
  Ticked,
  ticks,
  Watched,
  watched,
  watchedPlainly,
} from "../support/event-types.js";

const Rpc = ActionRpc.make([Open, Watched, Ticked], { authentication: Login, error: [QuotaError] });

expectTypeOf(Rpc.actions).toEqualTypeOf<ReadonlyArray<typeof Open>>();

expectTypeOf(Rpc.events).toEqualTypeOf<ReadonlyArray<typeof Watched | typeof Ticked>>();

// @ts-expect-error -- A protected event is bound only with authentication.
ActionRpc.make([Watched]);

const served = ActionRpc.layer(Rpc, [opened, watched, ticks]);

expectTypeOf<
  HttpRouter.Request.Only<"Requires", Layer.Services<typeof served>>
>().toEqualTypeOf<Region>();

expectTypeOf<Store | Authentication.Provider<Caller, "events-types.Login">>().toExtend<
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

const servedThroughMiddleware = ActionRpc.layer(Rpc, [opened, readingBoth], {
  middleware: [ResolveRegion],
});

expectTypeOf<
  HttpRouter.Request.Only<"Requires", Layer.Services<typeof servedThroughMiddleware>>
>().toBeNever();

class NeedsCaller extends RpcMiddleware.Service<NeedsCaller, { requires: Caller }>()(
  "rpc-events-types/NeedsCaller",
) {}

const protectedEventsThroughIdentityMiddleware = ActionRpc.layer(Rpc, [watchedPlainly], {
  actions: [Watched],
  middleware: [NeedsCaller],
});

expectTypeOf<
  HttpRouter.Request.Only<
    "Requires",
    Layer.Services<typeof protectedEventsThroughIdentityMiddleware>
  >
>().toBeNever();
