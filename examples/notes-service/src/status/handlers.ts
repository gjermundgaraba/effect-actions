import * as Action from "@gjermundgaraba/effect-actions/Action";
import { Effect } from "effect";

import { NoteStore } from "../notes/store.js";
import { GetStatus } from "./Status.js";

// A public action takes no `authorize`: nothing would run it.
export const status = Action.implement(
  GetStatus,
  Effect.gen(function* () {
    const store = yield* NoteStore;

    return () =>
      Effect.map(store.count, (notes) => ({ service: "notes-service", notes }));
  })
);
