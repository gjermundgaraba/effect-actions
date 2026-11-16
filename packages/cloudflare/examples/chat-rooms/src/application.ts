import * as CloudflareDurableObjects from "@effect/platform-cloudflare/CloudflareDurableObjects";
import * as ActionCluster from "@gjermundgaraba/effect-actions-cloudflare/ActionCluster";
import { Layer } from "effect";
import { HttpServer } from "effect/http";

import { Room } from "./entities.js";
import { entities, workerRoutes } from "./routes.js";

const quickOnceTheClusterIsBuilt = Layer.mergeAll(
  entities,
  workerRoutes.pipe(Layer.provide(HttpServer.layerServices))
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

export const initialize = CloudflareDurableObjects.setInitializer(
  ActionCluster.initializer(application)
);
