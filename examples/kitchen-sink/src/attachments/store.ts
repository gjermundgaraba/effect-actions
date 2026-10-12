import { Context, Effect, Layer } from "effect";
import type * as Action from "@gjermundgaraba/effect-actions/Action";
import type { IssueNotFound } from "../issues/Issues.js";
import { IssueStore } from "../issues/store.js";
import { type Attachment, AttachmentNotFound } from "./Attachments.js";

type Image = typeof Action.Image.Type;

interface Stored {
  readonly attachment: Attachment;
  readonly image: Image;
}

/** Images attached to issues, each in its issue's workspace, as `IssueStore` keeps issues. */
export class AttachmentStore extends Context.Service<
  AttachmentStore,
  {
    readonly add: (
      workspace: string,
      issue: string,
      name: string,
      image: Image,
    ) => Effect.Effect<Attachment, IssueNotFound>;
    readonly get: (workspace: string, id: string) => Effect.Effect<Stored, AttachmentNotFound>;
  }
>()("tracker/AttachmentStore") {
  // DEMO ONLY: memory. A service captures what it depends on when it is built, here the issue
  // store, so its methods require nothing.
  static readonly layerMemory = Layer.effect(
    AttachmentStore,
    Effect.gen(function* () {
      const issues = yield* IssueStore;
      const stored = new Map<string, Stored>();

      return AttachmentStore.of({
        add: Effect.fn("AttachmentStore.add")(function* (workspace, issue, name, image) {
          yield* issues.get(workspace, issue);

          const attachment = {
            id: crypto.randomUUID(),
            issue,
            name,
            mimeType: image.mimeType,
            size: image.data.byteLength,
          };

          stored.set(`${workspace}/${attachment.id}`, { attachment, image });

          return attachment;
        }),
        get: (workspace, id) =>
          Effect.fromNullishOr(stored.get(`${workspace}/${id}`)).pipe(
            Effect.mapError(() => new AttachmentNotFound({ id })),
          ),
      });
    }),
  );
}
