import * as Action from "@gjermundgaraba/effect-actions/Action";
import { Effect } from "effect";

import { authorize } from "../identity/authorize.js";
import { CurrentMember } from "../identity/Identity.js";
import { writeLimit } from "../issues/write-limit.js";
import { Attachments } from "./Attachments.js";
import { AttachmentStore } from "./store.js";

export const attachments = Action.implement(
  Attachments,
  Effect.gen(function* () {
    const store = yield* AttachmentStore;
    const limited = yield* writeLimit;

    return {
      attachImage: ({ issue, name, image }) =>
        Effect.gen(function* () {
          if (!image.mimeType.startsWith("image/")) {
            const message = "Expected an image MIME type.";

            return yield* new Action.InvalidInput({
              message,
              issues: [{ path: ["image", "mimeType"], message }],
            });
          }

          return yield* limited((member) =>
            store.add(member.workspace, issue, name, image)
          );
        }),
      getAttachment: ({ id }) =>
        Effect.flatMap(CurrentMember, (member) =>
          store.get(member.workspace, id)
        ),
    };
  }),
  { authorize }
);
