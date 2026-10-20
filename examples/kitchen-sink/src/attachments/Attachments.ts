import { Schema } from "effect";
import * as Action from "@gjermundgaraba/effect-actions/Action";
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

export class AttachmentNotFound extends Schema.TaggedError<AttachmentNotFound>()(
  "AttachmentNotFound",
  { id: Schema.String },
  { httpApiStatus: 404 },
) {}

// `Action.Image` is `{ data: Uint8Array, mimeType: string }`. In an input it is JSON over HTTP,
// RPC and the CLI, the bytes in base64.
export const AttachImage = Action.make("attachImage", {
  description: "Attach an image, such as a screenshot, to an issue.",
  input: { issue: Schema.String, name: Schema.String, image: Action.Image },
  success: Attachment,
  error: IssueWriteErrors,
  readOnly: false,
  caller: CurrentMember,
});

// `Action.Image` as a top-level field of the success, so an MCP tool shows the model the image
// itself, beside the JSON of `{ attachment }`.
export const GetAttachment = Action.make("getAttachment", {
  description: "Fetch an attachment: its name and size, and the image itself.",
  input: { id: Schema.String },
  success: { attachment: Attachment, image: Action.Image },
  error: AttachmentNotFound,
  readOnly: true,
  caller: CurrentMember,
});

export const Attachments = [AttachImage, GetAttachment] as const;
