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
  // A write to an issue as a comment is: the errors those declare, the write limit's included.
  error: IssueWriteErrors,
  readOnly: false,
  caller: CurrentMember,
});

// `Action.Image` as a top-level field of the success: an MCP tool lifts it out of the result
// into an image block the model sees as an image, beside the JSON of `{ attachment }`. HTTP,
// RPC and the CLI send it as JSON. A model never reads a media field's own description, so the
// action's description says what the image is.
export const GetAttachment = Action.make("getAttachment", {
  description: "Fetch an attachment: its name and size, and the image itself.",
  input: { id: Schema.String },
  success: { attachment: Attachment, image: Action.Image },
  error: AttachmentNotFound,
  readOnly: true,
  caller: CurrentMember,
});

export const Attachments = [AttachImage, GetAttachment] as const;
