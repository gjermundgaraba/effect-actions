import { Effect } from "effect";
import * as Action from "@gjermundgaraba/effect-actions/Action";
import { authorize } from "../identity/authorize.js";
import { CurrentUser } from "../identity/Identity.js";
import { Notes } from "./Notes.js";
import { NoteStore } from "./store.js";

// The builder runs once, at startup, however many surfaces serve these actions: it is where a
// handler gets the services that last the process, never the caller. `CurrentUser` is read per
// call, inside each handler. Each handler is a thin step from the contract to the store, and
// none checks a scope: `authorize` has run before it.
export const notes = Action.implement(
  Notes,
  Effect.gen(function* () {
    const store = yield* NoteStore;

    return {
      listNotes: () =>
        Effect.gen(function* () {
          const user = yield* CurrentUser;
          const owned = yield* store.list(user.id);

          return { notes: owned.map(({ id, title }) => ({ id, title })) };
        }),
      getNote: ({ id }) => Effect.flatMap(CurrentUser, (user) => store.get(user.id, id)),
      createNote: ({ requestId, title, body }) =>
        Effect.flatMap(CurrentUser, (user) => store.create(user.id, title, body, requestId)),
      updateNote: ({ id, body, revision }) =>
        Effect.flatMap(CurrentUser, (user) => store.update(user.id, id, body, revision)),
      deleteNote: ({ id }) => Effect.flatMap(CurrentUser, (user) => store.remove(user.id, id)),
      importNotes: ({ notes }) =>
        Effect.map(
          Effect.flatMap(CurrentUser, (user) => store.createAll(user.id, notes)),
          (created) => ({ notes: created }),
        ),
    };
  }),
  { authorize },
);
