import * as Event from "@gjermundgaraba/effect-actions/Event";
import { Effect } from "effect";

import { PreviewsChanged } from "./Lobby.js";
import { PreviewStore } from "./store.js";

// Every room's preview as one event, read from the lobby's store: a current source, for a value
// small enough to send whole. A page watching is sent the previews as they are, then again after
// each notify, which `roomChanged` makes after each change, so it needs no read before it and is
// never sent each change it missed, which a whole value makes needless. The object keeps the
// revision a page's cursor holds, so a page resuming at the latest is sent nothing.
export const previewEvents = Event.implement(
  PreviewsChanged,
  Effect.map(PreviewStore, (store) => ({
    current: () => Effect.map(store.read, (previews) => ({ previews })),
  }))
);
