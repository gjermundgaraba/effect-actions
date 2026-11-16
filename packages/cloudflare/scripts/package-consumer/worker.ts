import * as ActionCluster from "@gjermundgaraba/effect-actions-cloudflare/ActionCluster";
import * as Action from "@gjermundgaraba/effect-actions/Action";
import * as ActionEntity from "@gjermundgaraba/effect-actions/ActionEntity";
import * as ActionRpc from "@gjermundgaraba/effect-actions/ActionRpc";
import { Effect, Layer, Schema } from "effect";
import type { Sharding } from "effect/cluster";

export {
  ClusterDurableQueue,
  ClusterEntity,
  ClusterSingleton,
  ClusterWorkflow,
} from "@effect/platform-cloudflare/CloudflareDurableObjects";

interface Env {
  readonly CLUSTER_ENTITY: DurableObjectNamespace;
  readonly CLUSTER_WORKFLOW: DurableObjectNamespace;
  readonly CLUSTER_QUEUE: DurableObjectNamespace;
  readonly CLUSTER_SINGLETON: DurableObjectNamespace;
}

export const Ping = Action.make("ping", {
  description: "Answer pong",
  input: { room: Schema.String },
  readOnly: true,
  caller: Action.Anyone,
  success: Schema.Literal("pong"),
});

export const Room = ActionEntity.make("Room", ActionRpc.make([Ping]), {
  key: ({ room }) => room,
});

const options = (env: Env) => ({
  entities: [Room],
  entityNamespace: env.CLUSTER_ENTITY,
  workflowNamespace: env.CLUSTER_WORKFLOW,
  queueNamespace: env.CLUSTER_QUEUE,
  singletonNamespace: env.CLUSTER_SINGLETON,
});

export const cluster = (env: Env): Layer.Layer<Sharding.Sharding> =>
  ActionCluster.layer(options(env));

export const served = (env: Env): Layer.Layer<never> =>
  ActionEntity.layer(
    Room,
    Action.implement(Ping, () => Effect.succeed("pong" as const))
  ).pipe(Layer.provide(cluster(env)));

export const checkLayerTypes = (env: Env) => {
  // @ts-expect-error -- Published declarations must type what the layer provides.
  const wrong: Layer.Layer<number> = ActionCluster.layer(options(env));

  // @ts-expect-error -- Published declarations must require the four namespaces.
  ActionCluster.layer({
    entities: [Room],
    entityNamespace: env.CLUSTER_ENTITY,
  });

  return wrong;
};
