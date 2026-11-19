import * as ActionWorker from "@gjermundgaraba/effect-actions-cloudflare/ActionWorker";
import { Schema } from "effect";

import { DemoRoomName } from "./chat/Chat.js";
import { Room } from "./entities.js";
import { rooms, workerRoutes } from "./routes.js";
import { protocolVersion, RoomSocket, unsupportedProtocol } from "./Rpc.js";

const isRoom = Schema.is(DemoRoomName);

const worker = ActionWorker.make<Cloudflare.Env>({
  entities: [
    {
      entity: Room,
      layer: () => rooms,
      socket: {
        path: "/rooms/:id/rpc",
        id: (room) => (isRoom(room) ? room : undefined),
        actions: RoomSocket.events,
        protocol: { version: protocolVersion, code: unsupportedProtocol },
      },
    },
  ],
  routes: () => workerRoutes,
});

export class ClusterEntity extends worker.ClusterEntity {}

export const {
  context,
  ClusterWorkflow,
  ClusterDurableQueue,
  ClusterSingleton,
} = worker;

export default { fetch: worker.fetch };
