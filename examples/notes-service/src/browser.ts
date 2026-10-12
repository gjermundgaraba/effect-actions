import { Effect } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import * as ActionHttp from "@gjermundgaraba/effect-actions/ActionHttp";
import { Http } from "./Api.js";
import type { Note } from "./notes/Notes.js";

// Client module: what a web page imports. It holds the binding and nothing of the server, so a
// bundler gets the contracts and Effect's fetch client, and no handler.
//
// Without `baseUrl` the routes are called on the page's own origin. A page served elsewhere
// passes the API's URL, and the server must then allow its origin (CORS).
export const connect = (token: string, baseUrl?: string) => {
  // Built once, outside any Effect. Every method is typed from its action.
  const api = ActionHttp.fetchClient(Http, {
    transformClient: HttpClient.mapRequest(HttpClientRequest.bearerToken(token)),
    ...(baseUrl === undefined ? {} : { baseUrl }),
  });

  // Each method returns a promise. A failure rejects it with the decoded error, so in a `catch`
  // `error instanceof Action.Unauthenticated` tells an expired sign-in from anything else.
  return {
    notes: () => Effect.runPromise(api.listNotes()),

    // A declared error can also be handled by its tag before the promise: a missing note is
    // `undefined` here, and every other failure still rejects.
    note: (id: string): Promise<Note | undefined> =>
      api.getNote({ id }).pipe(
        Effect.catchTag("NoteNotFound", () => Effect.succeed(undefined)),
        Effect.runPromise,
      ),

    // A stale revision is refused, never overwritten: the error carries the current one.
    save: (note: Note, body: string) =>
      api.updateNote({ id: note.id, body, revision: note.revision }).pipe(
        Effect.catchTag("NoteChanged", ({ revision }) =>
          Effect.fail(new Error(`Someone else saved revision ${revision}. Reload the note.`)),
        ),
        Effect.runPromise,
      ),
  };
};
