import * as ActionHttp from "@gjermundgaraba/effect-actions/ActionHttp";
import { Effect } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";

import { Http } from "./Api.js";
import type { Note } from "./notes/Notes.js";

export const connect = (token: string, baseUrl?: string) => {
  const api = ActionHttp.fetchClient(Http, {
    transformClient: HttpClient.mapRequest(
      HttpClientRequest.bearerToken(token)
    ),
    ...(baseUrl === undefined ? {} : { baseUrl }),
  });

  return {
    notes: async () => await Effect.runPromise(api.listNotes()),

    note: async (id: string): Promise<Note | undefined> =>
      await api.getNote({ id }).pipe(
        Effect.catchTag("NoteNotFound", () => Effect.undefined),
        Effect.runPromise
      ),

    save: async (note: Note, body: string) =>
      await Effect.runPromise(
        api.updateNote({ id: note.id, body, revision: note.revision })
      ),
  };
};
