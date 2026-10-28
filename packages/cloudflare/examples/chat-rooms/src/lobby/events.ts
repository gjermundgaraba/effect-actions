import * as Event from "@gjermundgaraba/effect-actions/Event";
import { Effect } from "effect";

import { PreviewsChanged } from "./Lobby.js";
import { PreviewStore } from "./store.js";

export const previewEvents = Event.implement(
  PreviewsChanged,
  Effect.map(PreviewStore, (store) => ({
    current: () => Effect.map(store.read, (previews) => ({ previews })),
  }))
);
