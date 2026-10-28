import * as Action from "@gjermundgaraba/effect-actions/Action";
import * as Event from "@gjermundgaraba/effect-actions/Event";
import { Effect } from "effect";

import { LobbyCalls } from "./Calls.js";
import { LobbyHost } from "./host.js";
import { Previews, PreviewsChanged } from "./Lobby.js";
import { PreviewStore } from "./store.js";

export const lobby = Action.implement(
  Previews,
  Effect.map(
    LobbyHost,
    (host) => () => Effect.map(host.previews, (previews) => ({ previews }))
  )
);

export const calls = LobbyCalls.toLayer(
  Effect.gen(function* () {
    const store = yield* PreviewStore;
    const events = yield* Event.Events;

    return LobbyCalls.of({
      roomChanged: ({ room, latestAt }) =>
        Effect.flatMap(store.record(room, latestAt), (changed) =>
          changed ? events.notify(PreviewsChanged) : Effect.void
        ),
      previews: () => store.read,
    });
  })
);
