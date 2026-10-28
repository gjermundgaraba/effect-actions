import { WorkerEntrypoint } from "cloudflare:workers";
import { Effect, Schema } from "effect";

import { DemoRoomName } from "./chat/Chat.js";
import { LobbyHost } from "./lobby/host.js";
import { layerLobbyHost } from "./platform/lobby-stubs.js";

const decodeRoom = Schema.decodeUnknownEffect(DemoRoomName);

export class RoomsEntrypoint extends WorkerEntrypoint {
  async latestAt(room: string) {
    return await Effect.runPromise(
      Effect.flatMap(decodeRoom(room), (name) =>
        LobbyHost.use((lobby) =>
          Effect.map(
            lobby.previews,
            (previews) =>
              previews.find((preview) => preview.room === name)?.latestAt ??
              null
          )
        )
      ).pipe(Effect.provide(layerLobbyHost))
    );
  }
}
