import * as Action from "@gjermundgaraba/effect-actions/Action";
import { Schema } from "effect";

import { CurrentMember } from "../identity/Identity.js";
import { IssueWriteErrors } from "../issues/Issues.js";

export const Attachment = Schema.Struct({
  id: Schema.String,
  issue: Schema.String,
  name: Schema.String,
  mimeType: Schema.String,
  size: Schema.Finite,
});

export type Attachment = typeof Attachment.Type;

export class AttachmentNotFound extends Schema.TaggedError<
  AttachmentNotFound,
  { readonly brand: unique symbol }
>()("AttachmentNotFound", { id: Schema.String }, { httpApiStatus: 404 }) {}

export const AttachImage = Action.make("attachImage", {
  description: "Attach an image, such as a screenshot, to an issue.",
  input: { issue: Schema.String, name: Schema.String, image: Action.Image },
  success: Attachment,
  error: IssueWriteErrors,
  readOnly: false,
  caller: CurrentMember,
});

export const GetAttachment = Action.make("getAttachment", {
  description: "Fetch an attachment: its name and size, and the image itself.",
  input: { id: Schema.String },
  success: { attachment: Attachment, image: Action.Image },
  error: AttachmentNotFound,
  readOnly: true,
  caller: CurrentMember,
});

export const Attachments = [AttachImage, GetAttachment] as const;
