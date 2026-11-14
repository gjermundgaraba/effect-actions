import * as CloudflareDurableObjects from "@effect/platform-cloudflare/CloudflareDurableObjects";
import * as ActionCluster from "@gjermundgaraba/effect-actions-cloudflare/ActionCluster";
import { Layer, ManagedRuntime } from "effect";
import { HttpRouter, HttpServer } from "effect/http";

import { Room } from "./entities.js";
import { entities, workerRoutes } from "./routes.js";

const quickOnceTheClusterIsBuilt = Layer.mergeAll(
  entities,
  workerRoutes.pipe(
    Layer.provideMerge(HttpRouter.layer),
    Layer.provide(HttpServer.layerServices)
  )
);

const application = (env: Cloudflare.Env) =>
  quickOnceTheClusterIsBuilt.pipe(
    Layer.provideMerge(
      ActionCluster.layer({
        entities: [Room],
        entityNamespace: env.CLUSTER_ENTITY,
        workflowNamespace: env.CLUSTER_WORKFLOW,
        queueNamespace: env.CLUSTER_QUEUE,
        singletonNamespace: env.CLUSTER_SINGLETON,
      })
    )
  );

export type Application = Layer.Success<ReturnType<typeof application>>;

let running: ManagedRuntime.ManagedRuntime<Application, never> | undefined;

export const initialize = CloudflareDurableObjects.setInitializer(
  async (env: Cloudflare.Env) => {
    if (running !== undefined) {
      return await running.context();
    }

    const runtime = ManagedRuntime.make(Layer.orDie(application(env)));

    const context = await runtime.context().catch(async (error: unknown) => {
      await runtime.dispose();

      throw error;
    });

    running ??= runtime;

    if (running === runtime) {
      return context;
    }

    await runtime.dispose();

    return await running.context();
  }
);
