import { Effect, Semaphore } from "effect";
import * as Action from "@gjermundgaraba/effect-actions/Action";
import * as Event from "@gjermundgaraba/effect-actions/Event";
import { LobbyCalls } from "./Calls.js";
import { LobbyHost } from "./host.js";
import { Previews, PreviewsChanged } from "./Lobby.js";
import { Rooms } from "./rooms.js";
import { PreviewStore } from "./store.js";

// The Worker's `previews`, as the lobby's object keeps them.
export const lobby = Action.implement(
  Previews,
  Effect.map(LobbyHost, (host) => () => Effect.map(host.previews, (previews) => ({ previews }))),
);

// The lobby's own API, in its object. A room that changed is read again over its stub, one
// change at a time: while a call waits on another object, its object runs other calls, so two
// changes read at once could finish in either order, and the earlier read would be kept. Read
// in turn, the last change heard is read last, after the room's last write. A change notifies
// `PreviewsChanged`, which an object outside this one could not do itself: its event is this
// object's.
export const calls = LobbyCalls.toLayer(
  Effect.gen(function* () {
    const store = yield* PreviewStore;
    const rooms = yield* Rooms;
    const events = yield* Event.Events;
    const inTurn = Semaphore.withPermit(yield* Semaphore.make(1));

    return LobbyCalls.of({
      roomChanged: ({ room }) =>
        Effect.gen(function* () {
          const changed = yield* store.record(room, yield* rooms.latestAt(room));

          if (changed) yield* events.notify(PreviewsChanged);
        }).pipe(inTurn),
      previews: () => store.read,
    });
  }),
);
