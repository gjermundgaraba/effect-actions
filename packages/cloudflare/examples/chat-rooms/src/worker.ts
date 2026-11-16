import * as ActionCluster from "@gjermundgaraba/effect-actions-cloudflare/ActionCluster";
import * as ActionClusterEntity from "@gjermundgaraba/effect-actions-cloudflare/ActionClusterEntity";
import { Schema } from "effect";

import { initialize } from "./application.js";
import { DemoRoomName } from "./chat/Chat.js";
import { Room } from "./entities.js";
import { protocolVersion, unsupportedProtocol } from "./Rpc.js";

export {
  ClusterDurableQueue,
  ClusterSingleton,
  ClusterWorkflow,
} from "@effect/platform-cloudflare/CloudflareDurableObjects";

export class ClusterEntity extends ActionClusterEntity.make({
  initialize,
  sockets: [Room],
  protocol: { version: protocolVersion, code: unsupportedProtocol },
}) {}

const isRoom = Schema.is(DemoRoomName);

export default ActionCluster.handler(initialize, {
  sockets: {
    entityNamespace: (env) => env.CLUSTER_ENTITY,
    routes: [
      {
        entity: Room,
        path: "/rooms/:id/rpc",
        id: (room) => (isRoom(room) ? room : undefined),
      },
    ],
  },
});
