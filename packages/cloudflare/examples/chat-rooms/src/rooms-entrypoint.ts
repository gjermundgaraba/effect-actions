import { WorkerEntrypoint } from "cloudflare:workers";
import { Effect, Schema } from "effect";
import { RoomName } from "./chat/Chat.js";
import { Rooms } from "./lobby/rooms.js";
import { layerRooms } from "./platform/room-stubs.js";

const decodeRoom = Schema.decodeUnknownEffect(RoomName);

// The rooms for another Worker, over a service binding to this one's `RoomsEntrypoint`, which
// worker.ts exports. A method of a `WorkerEntrypoint` is no Effect program, so each call runs as
// one, given the rooms' Layer: the client is built in the request that uses it, and closed with
// it, which costs no I/O. A client kept across requests instead, in a `ManagedRuntime` made at
// module scope, would be built at its first run, inside a request: one that ends without waiting
// on I/O, succeeding or refused, never starts the client's receive fiber, and every later call
// through it waits for good. The stub page says how to share one safely.
export class RoomsEntrypoint extends WorkerEntrypoint<Cloudflare.Env> {
  // The calling Worker is another deployment, so its room is checked as any input is: an unknown
  // room rejects the call with the schema's error, as a room that cannot be reached rejects it
  // with the defect room-stubs.ts makes of it.
  latestAt(room: string) {
    return Effect.runPromise(
      Effect.flatMap(decodeRoom(room), (name) => Rooms.use((rooms) => rooms.latestAt(name))).pipe(
        Effect.provide(layerRooms),
      ),
    );
  }
}
