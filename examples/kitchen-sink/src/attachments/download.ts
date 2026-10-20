import { Effect, Layer } from "effect";
import { HttpRouter, HttpServerResponse } from "effect/http";
import * as Authentication from "@gjermundgaraba/effect-actions/Authentication";
import { authorize } from "../identity/authorize.js";
import { CurrentMember, Session } from "../identity/Identity.js";
import { GetAttachment } from "./Attachments.js";
import { AttachmentStore } from "./store.js";

// A route of the host's own: `GET /attachments/<id>` answers the image's bytes, for an `<img>`
// of the web app, which no action can (an action answers JSON), behind
// `Authentication.protect(Session)`: the page's cookie, which the web app's rpcs use. A token
// holder has no use for it: `getAttachment` gives an API client the same image.
export const download = Layer.unwrap(
  Effect.map(AttachmentStore, (store) =>
    HttpRouter.add(
      "GET",
      "/attachments/:id",
      Effect.gen(function* () {
        // The rule of the action it mirrors.
        yield* authorize(GetAttachment);

        const member = yield* CurrentMember;
        const { id = "" } = yield* HttpRouter.params;
        const { image } = yield* store.get(member.workspace, id);

        // An attachment never changes, but it is one workspace's: `private`.
        return HttpServerResponse.uint8Array(image.data, {
          contentType: image.mimeType,
          headers: {
            "cache-control": "private, max-age=31536000, immutable",
            // What a member uploaded is served from the application's own origin, and an image
            // can be a document: an SVG opened by its URL, not in an `<img>`, runs its scripts
            // as the member reading it. `sandbox` gives it no origin and no scripts, and
            // `nosniff` keeps the browser to the type stated.
            "content-security-policy": "sandbox",
            "x-content-type-options": "nosniff",
          },
        });
      }).pipe(
        Effect.catchTag("AttachmentNotFound", () =>
          Effect.succeed(HttpServerResponse.empty({ status: 404 })),
        ),
      ),
    ).pipe(Layer.provide(Authentication.protect(Session).layer)),
  ),
);
