import { describe, expect, it } from "@effect/vitest";
import * as Action from "@gjermundgaraba/effect-actions/Action";
import * as ActionMcp from "@gjermundgaraba/effect-actions/ActionMcp";
import * as Testing from "@gjermundgaraba/effect-actions/Testing";
import { Effect } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";

import { CreateNote, GetNote } from "../src/notes/Notes.js";
import { GetStatus } from "../src/status/Status.js";
import worker from "../src/worker.js";

const served = Testing.layer(worker.fetch);

const as = (token: string) => ({
  transformClient: HttpClient.mapRequest(HttpClientRequest.bearerToken(token)),
});

describe("the worker", () => {
  it.effect(
    "serves the tools, each request as the caller it authenticates",
    () =>
      Effect.gen(function* () {
        const anyone = yield* ActionMcp.client([GetStatus, GetNote]);
        const ada = yield* ActionMcp.client([CreateNote, GetNote], as("ada"));

        expect(yield* anyone.getStatus()).toMatchObject({
          service: "notes-service",
        });

        const note = yield* ada.createNote({
          title: "Plan",
          body: "First draft",
        });

        expect(yield* ada.getNote({ id: note.id })).toStrictEqual(note);
        expect(
          yield* Effect.flip(anyone.getNote({ id: note.id }))
        ).toBeInstanceOf(Action.Unauthenticated);
      }).pipe(Effect.provide(served))
  );
});
