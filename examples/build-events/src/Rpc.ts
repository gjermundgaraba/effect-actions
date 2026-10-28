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

export const Rpc = ActionRpc.make(
  [
    FinishBuild,
    StartBuild,
    TailLog,
    BuildFinished,
    PipelineStatus,
    RequestDeploy,
    DeployRequested,
  ],
  { authentication: Login }
);
