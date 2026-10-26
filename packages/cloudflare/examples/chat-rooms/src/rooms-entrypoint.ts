import { WorkerEntrypoint } from "cloudflare:workers";
import { Effect, Schema } from "effect";
import { RoomName } from "./chat/Chat.js";
import { LobbyHost } from "./lobby/host.js";
import { layerLobbyHost } from "./platform/lobby-stubs.js";

const decodeRoom = Schema.decodeUnknownEffect(RoomName);

// The rooms' activity for another Worker, over a service binding to this one's `RoomsEntrypoint`,
// which worker.ts exports, as the lobby keeps it. A method of a `WorkerEntrypoint` is no Effect
// program, so each call runs as one, given the lobby's Layer: its client is built in the request
// that uses it and closed with it, which costs no I/O. Why a client kept across requests strands
// is on `ActionDurableObject.layerStubClient`.
export class RoomsEntrypoint extends WorkerEntrypoint<Cloudflare.Env> {
  // The calling Worker is another deployment, so its room is checked as any input is: an unknown
  // room rejects the call with the schema's error, as a lobby that cannot be reached rejects it
  // with the defect lobby-stubs.ts makes of it.
  latestAt(room: string) {
    return Effect.runPromise(
      Effect.flatMap(decodeRoom(room), (name) =>
        LobbyHost.use((lobby) =>
          Effect.map(
            lobby.previews,
            (previews) => previews.find((preview) => preview.room === name)?.latestAt ?? null,
          ),
        ),
      ).pipe(Effect.provide(layerLobbyHost)),
    );
  }
}
