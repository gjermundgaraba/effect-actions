import * as ActionDurableObject from "@gjermundgaraba/effect-actions-cloudflare/ActionDurableObject";
import { env } from "cloudflare:workers";
import { Effect, Layer } from "effect";

import { Activity } from "../chat/activity.js";
import { Room } from "../chat/room.js";
import { MessageStore } from "../chat/store.js";
import { LobbyCalls } from "../lobby/Calls.js";
import { LobbyHost } from "../lobby/host.js";

// The lobby is one object, named `lobby`: a new stub for each call, read from `env` as the call
// is sent, never as the module loads.
const lobbyStub = () => env.CHAT_LOBBY.getByName("lobby");

// The lobby's object as the Worker reaches it, for the previews: a lobby that cannot be reached
// is the deployment's failure, not the caller's, so it is a defect, the Worker answers 500, and
// the cause is in its logs.
export const layerLobbyHost = Layer.effect(LobbyHost)(
  Effect.map(ActionDurableObject.client(LobbyCalls), (lobby) =>
    LobbyHost.of({ previews: Effect.orDie(lobby(lobbyStub).previews()) })
  )
);

// The room's task, worker.ts's `lobby`: telling the lobby the room's latest activity. The room's
// alarm runs its tasks one run at a time, each waiting for the lobby's answer, and each run reads
// the activity as it is then: the lobby hears a room's reports in the order the room made them,
// so a report heard late never overwrites a later one, and the last it hears is the room's
// latest. A run repeated after a lost answer sends what the lobby holds, which `record` finds
// unchanged, notifying no page.
export const tellLobby = Effect.gen(function* () {
  const room = yield* Room;
  const latest = yield* MessageStore.use((store) => store.latest);
  const lobby = yield* ActionDurableObject.client(LobbyCalls);

  yield* lobby(lobbyStub).roomChanged({ room, latestAt: latest?.at ?? null });
});

// A room's activity, a startup service of the room's: each change runs the `lobby` task after it,
// on the room's alarm once the call has answered, and again until the lobby hears it, so a lobby
// that cannot be reached fails no post and misses no change. `runAfter` marks the task before the
// change and again after it, so a crash at any point leaves the task to the alarm.
export const layerActivity = Layer.effect(Activity)(
  Effect.map(ActionDurableObject.Tasks, (tasks) =>
    Activity.of({ changing: (change) => tasks.runAfter("lobby", change) })
  )
);
