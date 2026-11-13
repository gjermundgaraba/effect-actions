import * as CloudflareCluster from "@effect/platform-cloudflare/CloudflareCluster";
import * as ActionClusterEntity from "@gjermundgaraba/effect-actions-cloudflare/ActionClusterEntity";
import { Context, Schema } from "effect";
import type { Scope } from "effect";
import { HttpEffect, HttpRouter } from "effect/http";
import type { HttpServerRequest } from "effect/http";

import { initialize } from "./application.js";
import type { Application } from "./application.js";
import { DemoRoomName } from "./chat/Chat.js";
import { Room } from "./entities.js";
import { protocolVersion, unsupportedProtocol } from "./Rpc.js";

export {
  ClusterDurableQueue,
  ClusterSingleton,
  ClusterWorkflow,
} from "@effect/platform-cloudflare/CloudflareDurableObjects";

export { RoomsEntrypoint } from "./rooms-entrypoint.js";

export class ClusterEntity extends ActionClusterEntity.make({
  initialize,
  sockets: [Room],
  protocol: { version: protocolVersion, code: unsupportedProtocol },
}) {}

const isRoom = Schema.is(DemoRoomName);

const roomSocket = /^\/rooms\/(?<room>[^/]+)\/rpc$/u;

export default {
  async fetch(request: Request, env: Cloudflare.Env) {
    const room = roomSocket.exec(new URL(request.url).pathname)?.groups?.room;

    if (room !== undefined && isRoom(room)) {
      return await env.CLUSTER_ENTITY.getByName(
        CloudflareCluster.encodeName(Room.type, room)
      ).fetch(request);
    }

    const context = await initialize(env);

    return await HttpEffect.toWebHandlerWith<
      Application,
      HttpServerRequest.HttpServerRequest | Scope.Scope
    >(context)(Context.get(context, HttpRouter.HttpRouter).asHttpEffect())(
      request
    );
  },
} satisfies ExportedHandler<Cloudflare.Env>;
