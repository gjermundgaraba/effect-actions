import * as Action from "@gjermundgaraba/effect-actions/Action";
import * as Authentication from "@gjermundgaraba/effect-actions/Authentication";
import { Context, Schema } from "effect";
import { HttpApiSecurity } from "effect/http-api";

import { Workspace, WorkspaceNotFound } from "../workspaces/Workspaces.js";

export interface KeyOperator {
  readonly id: string;
  readonly trusted: false;
}

export interface TrustedOperator {
  readonly id: string;
  readonly trusted: true;
}

export class Operator extends Context.Service<
  Operator,
  KeyOperator | TrustedOperator
>()("tracker/Operator") {}

export const OperatorKey = Authentication.make(
  "tracker.OperatorKey",
  Operator,
  {
    security: HttpApiSecurity.apiKey({ in: "header", key: "x-operator-key" }),
  }
);

const onWorkspace = {
  caller: Operator,
  input: { workspace: Schema.String },
  success: Workspace,
  error: WorkspaceNotFound,
  readOnly: false,
} as const;

export const ListWorkspaces = Action.make("listWorkspaces", {
  description: "List every workspace and whether it is suspended.",
  success: { workspaces: Schema.Array(Workspace) },
  readOnly: true,
  caller: Operator,
});

export const SuspendWorkspace = Action.make("suspendWorkspace", {
  ...onWorkspace,
  description:
    "Suspend a workspace: its members are refused on the public port until resumed.",
});

export const ResumeWorkspace = Action.make("resumeWorkspace", {
  ...onWorkspace,
  description: "Resume a suspended workspace.",
});

export const Admin = [
  ListWorkspaces,
  SuspendWorkspace,
  ResumeWorkspace,
] as const;
