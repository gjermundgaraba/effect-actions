import * as Action from "@gjermundgaraba/effect-actions/Action";
import { Schema } from "effect";

export const Workspace = Schema.Struct({
  slug: Schema.String,
  name: Schema.String,
  suspended: Schema.Boolean,
});

export type Workspace = typeof Workspace.Type;

export class WorkspaceNotFound extends Schema.TaggedError<
  WorkspaceNotFound,
  { readonly brand: unique symbol }
>()("WorkspaceNotFound", { slug: Schema.String }, { httpApiStatus: 404 }) {}

export const GetStatus = Action.make("getStatus", {
  description:
    "Report whether the tracker is up, since which start, and how many workspaces it serves.",
  success: {
    service: Schema.String,
    instance: Schema.String,
    workspaces: Schema.Finite,
  },
  readOnly: true,
  caller: Action.Anyone,
});
