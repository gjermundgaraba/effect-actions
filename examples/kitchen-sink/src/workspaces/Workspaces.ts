import { Schema } from "effect";
import * as Action from "@gjermundgaraba/effect-actions/Action";

export const Workspace = Schema.Struct({
  slug: Schema.String,
  name: Schema.String,
  suspended: Schema.Boolean,
});

export type Workspace = typeof Workspace.Type;

export class WorkspaceNotFound extends Schema.TaggedError<WorkspaceNotFound>()(
  "WorkspaceNotFound",
  { slug: Schema.String },
  { httpApiStatus: 404 },
) {}

// Public: `caller: Action.Anyone`. It answers before anyone has signed in, on every surface,
// so it tells nothing that depends on the caller.
export const GetStatus = Action.make("getStatus", {
  description:
    "Report whether the tracker is up, since which start, and how many workspaces it serves.",
  // `instance` names one start of the process: it changes on a restart, and with it the demo's
  // memory stores are empty again.
  success: { service: Schema.String, instance: Schema.String, workspaces: Schema.Finite },
  readOnly: true,
  caller: Action.Anyone,
});
