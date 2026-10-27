import { describe, expect, it } from "@effect/vitest";
import * as Action from "@gjermundgaraba/effect-actions/Action";
import * as ActionHttp from "@gjermundgaraba/effect-actions/ActionHttp";
import * as ActionMcp from "@gjermundgaraba/effect-actions/ActionMcp";
import * as Testing from "@gjermundgaraba/effect-actions/Testing";
import { Effect, Layer } from "effect";
import { HttpClient, HttpClientError, HttpClientRequest } from "effect/http";

import { Http } from "../src/Api.js";
import { Notes } from "../src/notes/Notes.js";
import { NoteStore } from "../src/notes/store.js";
import { routes } from "../src/routes.js";
import { GetStatus } from "../src/status/Status.js";

// What the wire adds: the real routes, behind their real authentication, answering in memory.
// No port is opened. The caller is the token each client sends, as in production. A service a
// builder yields is provided here, as server.ts provides it: one left out is a `Scope` error at
// every `it.effect` (docs/Testing-failures.md).
const served = Testing.layer(routes).pipe(Layer.provide(NoteStore.layerMemory));

const as = (token: string) => ({
  transformClient: HttpClient.mapRequest(HttpClientRequest.bearerToken(token)),
});

describe("the service, over HTTP and MCP", () => {
  it.effect(
    "answers the public action without a token and refuses a protected one",
    () =>
      Effect.gen(function* () {
        const anyone = yield* ActionHttp.client(Http);

        expect(yield* anyone.getStatus()).toStrictEqual({
          service: "notes-service",
          notes: 0,
        });
        expect(yield* Effect.flip(anyone.whoAmI())).toBeInstanceOf(
          Action.Unauthenticated
        );
      }).pipe(Effect.provide(served))
  );

  it.effect("refuses a token no user holds", () =>
    Effect.gen(function* () {
      const stranger = yield* ActionHttp.client(Http, as("mallory"));

      const refusal = yield* Effect.flip(stranger.whoAmI());

      expect(refusal).toBeInstanceOf(Action.Unauthenticated);
      expect(refusal.message).toBe("Unknown demo token.");
    }).pipe(Effect.provide(served))
  );

  it.effect("serves the host's own routes beside the actions'", () =>
    Effect.gen(function* () {
      const health = yield* HttpClient.get("/healthz");
      const openApi = yield* HttpClient.get("/api/openapi.json");

      expect(yield* health.text).toBe("ok");
      expect(yield* openApi.text).toContain('"/api/createNote"');
    }).pipe(Effect.provide(served))
  );

  it.effect(
    "names the scope a caller lacks, so an OAuth client can ask for it",
    () =>
      Effect.gen(function* () {
        const reader = yield* ActionHttp.client(Http, as("reader"));

        expect(yield* reader.whoAmI()).toStrictEqual({
          id: "reader",
          scopes: ["notes:read"],
        });

        const refusal = yield* Effect.flip(
          reader.createNote({ title: "Plan", body: "" })
        );

        expect(refusal).toBeInstanceOf(Action.Forbidden);
        expect(refusal).toHaveProperty("scopes", ["notes:write"]);
      }).pipe(Effect.provide(served))
  );

  it.effect(
    "serves one store to both surfaces: a note written over HTTP is read as a tool",
    () =>
      Effect.gen(function* () {
        const http = yield* ActionHttp.client(Http, as("ada"));
        const mcp = yield* ActionMcp.client([GetStatus, ...Notes], as("ada"));
        const note = yield* http.createNote({ title: "Plan", body: "Draft" });

        expect(yield* mcp.getNote({ id: note.id })).toStrictEqual(note);
        expect(yield* mcp.getStatus()).toStrictEqual({
          service: "notes-service",
          notes: 1,
        });
      }).pipe(Effect.provide(served))
  );

  it.effect(
    "lists protected tools to a signed-out MCP client, as one tool is public",
    () =>
      Effect.gen(function* () {
        const response = yield* HttpClient.execute(
          ActionMcp.request("tools/list")
        );

        expect(response.status).toBe(200);
        expect(yield* response.text).toContain('"name":"createNote"');
      }).pipe(Effect.provide(served))
  );

  it.effect(
    "retries a committed HTTP write over MCP after its response is lost",
    () =>
      Effect.gen(function* () {
        const http = yield* ActionHttp.client(Http, {
          transformClient: (client) =>
            client.pipe(
              as("ada").transformClient,
              // The real server finishes the write, but the caller receives no response.
              HttpClient.transform((response, request) =>
                response.pipe(
                  Effect.andThen(
                    Effect.fail(
                      new HttpClientError.HttpClientError({
                        reason: new HttpClientError.TransportError({
                          request,
                          description: "Response lost after commit",
                        }),
                      })
                    )
                  )
                )
              )
            ),
        });

        const mcp = yield* ActionMcp.client([GetStatus, ...Notes], as("ada"));
        const input = { requestId: "plan", title: "Plan", body: "Draft" };

        expect(yield* Effect.flip(http.createNote(input))).toBeInstanceOf(
          HttpClientError.HttpClientError
        );
        expect(yield* mcp.getStatus()).toStrictEqual({
          service: "notes-service",
          notes: 1,
        });

        const replay = yield* mcp.createNote(input);

        expect(replay).toMatchObject({
          title: "Plan",
          body: "Draft",
          revision: 1,
        });
        expect(yield* mcp.listNotes()).toStrictEqual({
          notes: [{ id: replay.id, title: "Plan" }],
        });
      }).pipe(Effect.provide(served))
  );
});
