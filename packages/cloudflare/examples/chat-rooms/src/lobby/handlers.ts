import { Effect } from "effect";
import * as Action from "@gjermundgaraba/effect-actions/Action";
import * as Event from "@gjermundgaraba/effect-actions/Event";
import { LobbyCalls } from "./Calls.js";
import { LobbyHost } from "./host.js";
import { Previews, PreviewsChanged } from "./Lobby.js";
import { PreviewStore } from "./store.js";

// The Worker's `previews`, as the lobby's object keeps them.
export const lobby = Action.implement(
  Previews,
  Effect.map(LobbyHost, (host) => () => Effect.map(host.previews, (previews) => ({ previews }))),
);

// The lobby's own API, in its object. A change notifies `PreviewsChanged`, which an object
// outside this one could not do itself: its event is this object's.
export const calls = LobbyCalls.toLayer(
  Effect.gen(function* () {
    const store = yield* PreviewStore;
    const events = yield* Event.Events;

    return LobbyCalls.of({
      roomChanged: ({ room, latestAt }) =>
        Effect.flatMap(store.record(room, latestAt), (changed) =>
          changed ? events.notify(PreviewsChanged) : Effect.void,
        ),
      previews: () => store.read,
    });
  }),
);
