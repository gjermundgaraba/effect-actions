import * as Authentication from "@gjermundgaraba/effect-actions/Authentication";
import { Effect, Layer } from "effect";
import { HttpRouter, HttpServerResponse } from "effect/http";

import { authorize } from "../identity/authorize.js";
import { CurrentMember, Session } from "../identity/Identity.js";
import { GetAttachment } from "./Attachments.js";
import { AttachmentStore } from "./store.js";

export const download = Layer.unwrap(
  Effect.map(AttachmentStore, (store) =>
    HttpRouter.add(
      "GET",
      "/attachments/:id",
      Effect.gen(function* () {
        yield* authorize(GetAttachment);

        const member = yield* CurrentMember;
        const { id = "" } = yield* HttpRouter.params;
        const { image } = yield* store.get(member.workspace, id);

        return HttpServerResponse.uint8Array(image.data, {
          contentType: image.mimeType,
          headers: {
            "cache-control": "private, max-age=31536000, immutable",
            "content-security-policy": "sandbox",
            "x-content-type-options": "nosniff",
          },
        });
      }).pipe(
        Effect.catchTag("AttachmentNotFound", () =>
          Effect.succeed(HttpServerResponse.empty({ status: 404 }))
        )
      )
    ).pipe(Layer.provide(Authentication.protect(Session).layer))
  )
);
