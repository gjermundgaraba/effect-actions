import { Context, Schema } from "effect";
import { HttpApiSecurity } from "effect/http-api";
import * as Action from "@gjermundgaraba/effect-actions/Action";
import * as Authentication from "@gjermundgaraba/effect-actions/Authentication";
import { Workspace, WorkspaceNotFound } from "../workspaces/Workspaces.js";

/** What a verified operator key can name. */
export interface KeyOperator {
  readonly id: string;
  readonly trusted: false;
}

/** What only a host supplies, on its own console. */
export interface TrustedOperator {
  readonly id: string;
  readonly trusted: true;
}

/**
 * The operators' identity, another audience than the members: its own service, its own
 * descriptor, its own port. Typed in two parts, so the trusted one cannot arrive over the wire.
 */
export class Operator extends Context.Service<Operator, KeyOperator | TrustedOperator>()(
  "tracker/Operator",
) {}

// How a remote operator proves it: an API key in a header, a native scheme named by
// `security`. A key cannot step up, and has no OAuth discovery.
export const OperatorKey = Authentication.make("tracker.OperatorKey", Operator, {
  security: HttpApiSecurity.apiKey({ in: "header", key: "x-operator-key" }),
});

// What the two actions on one workspace share, their input and success included.
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
  description: "Suspend a workspace: its members are refused on the public port until resumed.",
});

export const ResumeWorkspace = Action.make("resumeWorkspace", {
  ...onWorkspace,
  description: "Resume a suspended workspace.",
});

export const Admin = [ListWorkspaces, SuspendWorkspace, ResumeWorkspace] as const;
