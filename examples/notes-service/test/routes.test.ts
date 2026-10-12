import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import * as Action from "@gjermundgaraba/effect-actions/Action";
import * as ActionHttp from "@gjermundgaraba/effect-actions/ActionHttp";
import * as Testing from "@gjermundgaraba/effect-actions/Testing";
import { Http } from "../src/Api.js";
import { Notes } from "../src/notes/Notes.js";
import { NoteStore } from "../src/notes/store.js";
import { routes } from "../src/routes.js";
import { GetStatus } from "../src/status/Status.js";

// What the wire adds: the real routes, behind their real authentication, answering in memory.
// No port is opened. The caller is the token each client sends, as in production.
const served = Testing.layer(routes).pipe(Layer.provide(NoteStore.layerMemory));

const as = (token: string) => ({
  transformClient: HttpClient.mapRequest(HttpClientRequest.bearerToken(token)),
});

describe("the service, over HTTP and MCP", () => {
  it.effect("answers the public action without a token and refuses the rest", () =>
    Effect.gen(function* () {
      const anyone = yield* ActionHttp.client(Http);

      expect(yield* anyone.getStatus()).toEqual({ service: "notes-service", notes: 0 });
      expect(yield* Effect.flip(anyone.whoAmI())).toBeInstanceOf(Action.Unauthenticated);
    }).pipe(Effect.provide(served)),
  );

  it.effect("refuses a token no user holds", () =>
    Effect.gen(function* () {
      const stranger = yield* ActionHttp.client(Http, as("mallory"));

      const refusal = yield* Effect.flip(stranger.whoAmI());

      expect(refusal).toBeInstanceOf(Action.Unauthenticated);
      expect(refusal.message).toBe("Unknown demo token.");
    }).pipe(Effect.provide(served)),
  );

  it.effect("serves the host's own routes beside the actions'", () =>
    Effect.gen(function* () {
      const health = yield* HttpClient.get("/healthz");
      const openApi = yield* HttpClient.get("/api/openapi.json");

      expect(yield* health.text).toBe("ok");
      expect(yield* openApi.text).toContain('"/api/createNote"');
    }).pipe(Effect.provide(served)),
  );

  it.effect("names the scope a caller lacks, so an OAuth client can ask for it", () =>
    Effect.gen(function* () {
      const reader = yield* ActionHttp.client(Http, as("reader"));

      expect(yield* reader.whoAmI()).toEqual({ id: "reader", scopes: ["notes:read"] });

      const refusal = yield* Effect.flip(reader.createNote({ title: "Plan", body: "" }));

      expect(refusal).toBeInstanceOf(Action.Forbidden);
      expect(refusal).toHaveProperty("scopes", ["notes:write"]);
    }).pipe(Effect.provide(served)),
  );

  it.effect("serves one store to both surfaces: a note written over HTTP is read as a tool", () =>
    Effect.gen(function* () {
      const http = yield* ActionHttp.client(Http, as("ada"));
      const mcp = yield* Testing.mcpClient([GetStatus, ...Notes], as("ada"));
      const note = yield* http.createNote({ title: "Plan", body: "Draft" });

      expect(yield* mcp.getNote({ id: note.id })).toEqual(note);
      expect(yield* mcp.getStatus()).toEqual({ service: "notes-service", notes: 1 });
    }).pipe(Effect.provide(served)),
  );

  it.effect("lists every tool to a signed-out MCP client, as one of them is public", () =>
    Effect.gen(function* () {
      const response = yield* HttpClient.execute(Testing.mcpRequest("tools/list"));

      expect(response.status).toBe(200);
      expect(yield* response.text).toContain('"name":"createNote"');
    }).pipe(Effect.provide(served)),
  );
});
