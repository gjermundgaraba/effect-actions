import * as ActionRpc from "@gjermundgaraba/effect-actions/ActionRpc";
import {
  BuildFinished,
  FinishBuild,
  PipelineStatus,
  StartBuild,
  TailLog,
} from "./builds/Builds.js";
import { DeployRequested, RequestDeploy } from "./deploys/Deploys.js";
import { Login } from "./identity/Identity.js";

// The RPC binding: each action an rpc named after it, and each event a stream rpc named after
// it, which pushes each occurrence as the server reads it. Plain data, as the HTTP binding is.
export const Rpc = ActionRpc.make(
  [FinishBuild, StartBuild, TailLog, BuildFinished, PipelineStatus, RequestDeploy, DeployRequested],
  { authentication: Login },
);
