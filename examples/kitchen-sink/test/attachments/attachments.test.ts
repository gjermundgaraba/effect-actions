import { Buffer } from "node:buffer";
import { describe, expect, it } from "@effect/vitest";
import { Array, Effect, flow, Layer } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import * as Action from "@gjermundgaraba/effect-actions/Action";
import * as ActionHttp from "@gjermundgaraba/effect-actions/ActionHttp";
import * as Testing from "@gjermundgaraba/effect-actions/Testing";
import { Http } from "../../src/Api.js";
import { GetAttachment } from "../../src/attachments/Attachments.js";
import { RateLimited } from "../../src/issues/Issues.js";
import { memory } from "../../src/memory.js";
import { publicRoutes } from "../../src/routes.js";

const served = Testing.layer(publicRoutes).pipe(Layer.provide(memory));

const signedIn = (token: string, workspace: string) =>
  flow(HttpClientRequest.bearerToken(token), HttpClientRequest.setHeader("x-workspace", workspace));

const as = (token: string, workspace: string) => ({
  transformClient: HttpClient.mapRequest(signedIn(token, workspace)),
});

// A one-pixel PNG stands in for a screenshot.
const screenshot = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64",
);

const attached = Effect.gen(function* () {
  const ada = yield* ActionHttp.client(Http, as("ada", "acme"));
  const issue = yield* ada.createIssue({ title: "Crash", body: "" });

  return yield* ada.attachImage({
    issue: issue.id,
    name: "crash.png",
    image: { data: screenshot, mimeType: "image/png" },
  });
});

describe("attachments, over HTTP and MCP", () => {
  it.effect("sends an image as JSON over HTTP, and as an image block from the tool", () =>
    Effect.gen(function* () {
      const attachment = yield* attached;
      const http = yield* ActionHttp.client(Http, as("ada", "acme"));
      const mcp = yield* Testing.mcpClient([GetAttachment], as("ada", "acme"));

      expect(attachment).toMatchObject({ name: "crash.png", mimeType: "image/png", size: 68 });

      // Both clients decode the same success, the bytes a `Uint8Array` again.
      const overHttp = yield* http.getAttachment({ id: attachment.id });
      const overMcp = yield* mcp.getAttachment({ id: attachment.id });

      expect(Buffer.from(overHttp.image.data).equals(screenshot)).toBe(true);
      expect(overMcp).toEqual(overHttp);

      // As sent: the tool's result holds the rest of the success as JSON, and the image as a
      // content block of its own, which a model receives as an image.
      const call = yield* HttpClient.execute(
        Testing.mcpRequest(
          "tools/call",
          { name: "getAttachment", arguments: { id: attachment.id } },
          { headers: { authorization: "Bearer ada", "x-workspace": "acme" } },
        ),
      );

      const text = yield* call.text;

      expect(text).toContain('"type":"image"');
      expect(text).toContain('"mimeType":"image/png"');
      expect(text).toContain(`"structuredContent":{"attachment":{"id":"${attachment.id}"`);
    }).pipe(Effect.provide(served)),
  );

  it.effect("refuses a file that is no image as invalid input, naming the field", () =>
    Effect.gen(function* () {
      const ada = yield* ActionHttp.client(Http, as("ada", "acme"));
      const issue = yield* ada.createIssue({ title: "Crash", body: "" });

      const refused = yield* Effect.flip(
        ada.attachImage({
          issue: issue.id,
          name: "notes.txt",
          image: { data: screenshot, mimeType: "text/plain" },
        }),
      );

      expect(refused).toBeInstanceOf(Action.InvalidInput);
      expect(refused).toMatchObject({ issues: [{ path: ["image", "mimeType"] }] });
    }).pipe(Effect.provide(served)),
  );

  it.effect("counts an attachment against the issues' write limit", () =>
    Effect.gen(function* () {
      const attachment = yield* attached;
      const ada = yield* ActionHttp.client(Http, as("ada", "acme"));

      // `attached` spent two writes, an issue and its image. Eight comments spend the rest.
      yield* Effect.forEach(Array.range(1, 8), (n) =>
        ada.commentOnIssue({ id: attachment.issue, text: `Comment ${n}` }),
      );

      const refused = yield* Effect.flip(
        ada.attachImage({
          issue: attachment.issue,
          name: "again.png",
          image: { data: screenshot, mimeType: "image/png" },
        }),
      );

      expect(refused).toBeInstanceOf(RateLimited);
    }).pipe(Effect.provide(served)),
  );

  it.effect("serves the bytes to the web app's cookie, from the host's own route", () =>
    Effect.gen(function* () {
      const attachment = yield* attached;

      const download = (session: string) =>
        HttpClient.execute(
          HttpClientRequest.get(`/attachments/${attachment.id}`).pipe(
            HttpClientRequest.setHeader("cookie", `tracker_session=${session}`),
          ),
        );

      const mine = yield* download("ada-at-acme");
      const anotherWorkspace = yield* download("grace-at-globex");

      expect(mine.status).toBe(200);
      expect(Buffer.from(yield* mine.arrayBuffer).equals(screenshot)).toBe(true);
      // The route states its own caching; everything else authentication covers is `no-store`.
      expect(mine.headers["cache-control"]).toBe("private, max-age=31536000, immutable");
      // An uploaded image opened by its URL is a document on this origin: it gets no scripts.
      expect([
        mine.headers["content-security-policy"],
        mine.headers["x-content-type-options"],
      ]).toEqual(["sandbox", "nosniff"]);
      expect(anotherWorkspace.status).toBe(404);
    }).pipe(Effect.provide(served)),
  );

  it.effect("refuses, on that route, whom authentication and the route's rule refuse", () =>
    Effect.gen(function* () {
      const attachment = yield* attached;
      const download = HttpClientRequest.get(`/attachments/${attachment.id}`);
      const withCookie = HttpClientRequest.setHeader("cookie", "tracker_session=kay-at-acme");

      const signedOut = yield* HttpClient.execute(download);
      const withToken = yield* HttpClient.execute(signedIn("ada", "acme")(download));
      const withoutScope = yield* HttpClient.execute(withCookie(download));

      // A cookie scheme has no challenge. A token is no credential on this route.
      expect([signedOut.status, signedOut.headers["cache-control"]]).toEqual([401, "no-store"]);
      expect(signedOut.headers["www-authenticate"]).toBeUndefined();
      expect(withToken.status).toBe(401);
      // kay is signed in, in the right workspace, without the read scope: the route's own
      // `authorize` refuses.
      expect(withoutScope.status).toBe(403);
      expect(yield* withoutScope.json).toMatchObject({ message: "Requires issues:read." });
    }).pipe(Effect.provide(served)),
  );
});
