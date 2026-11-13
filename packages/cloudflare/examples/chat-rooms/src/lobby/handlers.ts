import * as Action from "@gjermundgaraba/effect-actions/Action";
import * as Event from "@gjermundgaraba/effect-actions/Event";
import { Effect } from "effect";
import type { Entity } from "effect/cluster";
import type { RpcGroup } from "effect/rpc";

import type { RoomChanges } from "./Changes.js";
import { Previews, PreviewsChanged } from "./Lobby.js";
import { PreviewStore } from "./store.js";

export const lobby = Action.implement(
  Previews,
  Effect.map(
    PreviewStore,
    (store) => () => Effect.map(store.read, (previews) => ({ previews }))
  )
);

export const roomChanges = Effect.gen(function* () {
  const store = yield* PreviewStore;
  const events = yield* Event.Events;

  return {
    roomChanged: ({ payload }) =>
      store.record(payload, events.notify(PreviewsChanged)),
  } satisfies Entity.HandlersFrom<RpcGroup.Rpcs<typeof RoomChanges>>;
});
