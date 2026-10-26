import { env } from "cloudflare:workers";
import { Effect, Layer, Schema, type Scope } from "effect";
import * as ActionDurableObject from "@gjermundgaraba/effect-actions-cloudflare/ActionDurableObject";
import { Activity } from "../chat/activity.js";
import { RoomName } from "../chat/Chat.js";
import { Room } from "../chat/room.js";
import { LobbyCalls } from "../lobby/Calls.js";
import { LobbyHost } from "../lobby/host.js";

// The lobby is one object, named `lobby`, reached as a room is: a new stub for each call, read
// from `env` as the call is sent.
const lobbyStub = () => env.CHAT_LOBBY.getByName("lobby");

// The lobby's object as the Worker reaches it, for the previews: a lobby that cannot be reached
// is a defect, as a room is in room-stubs.ts.
export const layerLobbyHost = Layer.effect(LobbyHost)(
  Effect.map(ActionDurableObject.client(LobbyCalls), (lobby) =>
    LobbyHost.of({ previews: Effect.orDie(lobby(lobbyStub).previews()) }),
  ),
);

// The room's task, worker.ts's `lobby`: telling the lobby that the room changed, so the lobby
// reads the room again. Its type is written out because the room's class and the lobby's each
// reach the other through a binding typed by the class: inferred, each class's type would wait
// on the other's.
export const tellLobby: Effect.Effect<void, unknown, Room | Scope.Scope> = Effect.gen(function* () {
  const room = Schema.decodeUnknownSync(RoomName)(yield* Room);
  const lobby = yield* ActionDurableObject.client(LobbyCalls);

  yield* lobby(lobbyStub).roomChanged({ room });
});

// A room's activity, a startup service of the room's: each change runs the `lobby` task after it,
// on the room's alarm once the call has answered, and again until the lobby hears it, so a lobby
// that cannot be reached fails no post and misses no change. `runAfter` marks the task before the
// change and again after it, so a crash at any point leaves the task to the alarm.
export const layerActivity: Layer.Layer<Activity, never, ActionDurableObject.Tasks> = Layer.effect(
  Activity,
)(
  Effect.map(ActionDurableObject.Tasks, (tasks) =>
    Activity.of({ changing: (change) => tasks.runAfter("lobby", change) }),
  ),
);
