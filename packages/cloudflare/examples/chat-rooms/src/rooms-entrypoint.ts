import * as ActionEntity from "@gjermundgaraba/effect-actions/ActionEntity";
import { WorkerEntrypoint } from "cloudflare:workers";
import { Effect, Schema } from "effect";

import { initialize } from "./application.js";
import { DemoRoomName } from "./chat/Chat.js";
import { Lobby } from "./entities.js";

const decodeRoom = Schema.decodeUnknownEffect(DemoRoomName);

export class RoomsEntrypoint extends WorkerEntrypoint {
  async latestAt(room: string) {
    const context = await initialize(this.env);

    return await Effect.runPromiseWith(context)(
      Effect.gen(function* () {
        const name = yield* decodeRoom(room);
        const lobbies = yield* ActionEntity.client(Lobby);
        const { previews } = yield* lobbies("lobby").previews();

        return (
          previews.find((preview) => preview.room === name)?.latestAt ?? null
        );
      })
    );
  }
}
