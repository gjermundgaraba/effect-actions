import { WorkerEntrypoint } from "cloudflare:workers";
import { Effect, Schema } from "effect";
import { RoomName } from "./chat/Chat.js";
import { Rooms } from "./lobby/rooms.js";
import { layerRooms } from "./platform/room-stubs.js";

const decodeRoom = Schema.decodeUnknownEffect(RoomName);

// The rooms for another Worker, over a service binding to this one's `RoomsEntrypoint`, which
// worker.ts exports. A method of a `WorkerEntrypoint` is no Effect program, so each call runs as
// one, given the rooms' Layer: the client is built in the request that uses it, and closed with
// it, which costs no I/O. A runtime kept across requests is built as the module loads instead,
// as worker.ts builds the lobby: one first built inside a request that ends without waiting on
// I/O, succeeding or refused, never starts its client's own fiber, and every later call through
// it waits for good. `ManagedRuntime.make` at module scope builds nothing until its first run,
// inside a request, so it is that lazy form unless it is run once as the module loads.
export class RoomsEntrypoint extends WorkerEntrypoint<Cloudflare.Env> {
  // The calling Worker is another deployment, so its room is checked as any input is: an unknown
  // room rejects the call with the schema's error, as a room that cannot be reached rejects it
  // with the defect.
  latestAt(room: string) {
    return Effect.runPromise(
      Effect.flatMap(decodeRoom(room), (name) => Rooms.use((rooms) => rooms.latestAt(name))).pipe(
        Effect.provide(layerRooms),
      ),
    );
  }
}
