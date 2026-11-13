import { expectTypeOf } from "@effect/vitest";
import { Context, Effect, Layer, Schedule, Schema } from "effect";
import type { Sharding } from "effect/cluster";
import { Entity } from "effect/cluster";
import { Rpc, RpcGroup, RpcMiddleware } from "effect/rpc";

import * as Action from "../../src/contract/Action.js";
import * as ActionEntity from "../../src/entity/ActionEntity.js";
import * as ActionRpc from "../../src/rpc/ActionRpc.js";

class Tally extends Context.Service<Tally, { count: number }>()(
  "natives-types/Tally"
) {}

class Audit extends RpcMiddleware.Service<Audit>()("natives-types/Audit") {}

const Natives = RpcGroup.make(Rpc.make("bump", { success: Schema.Int }));

const Audited = RpcGroup.make(
  Rpc.make("bump", { success: Schema.Int }).middleware(Audit)
);

const Peek = Action.make("peek", {
  description: "Read a counter",
  readOnly: true,
  caller: Action.Anyone,
  input: { counter: Schema.String },
  success: Schema.Int,
});

const binding = ActionRpc.make([Peek]);

const key = { peek: ({ counter }: { readonly counter: string }) => counter };

const Counter = ActionEntity.make("Counter", binding, { key, rpcs: Natives });

const AuditedCounter = ActionEntity.make("AuditedCounter", binding, {
  key,
  rpcs: Audited,
});

const Plain = ActionEntity.make("Plain", binding, { key });

const peek = Action.implement(
  Peek,
  Effect.map(Tally, (tally) => () => Effect.succeed(tally.count))
);

const rpcs = Effect.map(Tally, (tally) => ({
  bump: () => Effect.sync(() => (tally.count += 1)),
}));

const tallied = Layer.sync(Tally)(() => ({ count: 0 }));

type Requires<L> = L extends Layer.Layer<never, never, infer R> ? R : never;

// @ts-expect-error an entity with native rpcs needs their handlers
ActionEntity.layer(Counter, peek);

// @ts-expect-error an entity without native rpcs takes no handlers
ActionEntity.layer(Plain, peek, { rpcs });

// @ts-expect-error an entity without native rpcs takes no Effect building handlers either
ActionEntity.layer(Plain, peek, { rpcs: Effect.die("no natives") });

// @ts-expect-error a call that died is never run again, so layer takes no defectRetryPolicy
ActionEntity.layer(Plain, peek, { defectRetryPolicy: Schedule.recurs(1) });

const unprovided = ActionEntity.layer(Counter, peek, { rpcs });

expectTypeOf<Requires<typeof unprovided>>().toEqualTypeOf<
  Tally | Sharding.Sharding
>();

const perEntity = ActionEntity.layer(Counter, peek, {
  services: tallied,
  rpcs,
});

expectTypeOf<Requires<typeof perEntity>>().toEqualTypeOf<Sharding.Sharding>();

const answering = ActionEntity.layer(Counter, peek, {
  services: tallied,
  rpcs: {
    bump: () => Effect.map(Tally, (tally) => (tally.count += 1)),
  },
});

expectTypeOf<Requires<typeof answering>>().toEqualTypeOf<Sharding.Sharding>();

const readingAddress = ActionEntity.layer(Counter, peek, {
  services: Layer.effect(Tally)(
    Effect.map(Entity.CurrentAddress, () => ({ count: 0 }))
  ),
  rpcs,
});

expectTypeOf<
  Requires<typeof readingAddress>
>().toEqualTypeOf<Sharding.Sharding>();

const audited = ActionEntity.layer(AuditedCounter, peek, {
  services: tallied,
  rpcs,
});

expectTypeOf<Requires<typeof audited>>().toEqualTypeOf<
  Audit | Sharding.Sharding
>();

const plain = ActionEntity.layer(Plain, peek, { services: tallied });

expectTypeOf<Requires<typeof plain>>().toEqualTypeOf<Sharding.Sharding>();

expectTypeOf(Counter.client).toExtend<
  Effect.Effect<
    (entityId: string) => { readonly bump: (...args: never) => unknown },
    never,
    Sharding.Sharding
  >
>();
