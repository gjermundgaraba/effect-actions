import * as ActionHttp from "@gjermundgaraba/effect-actions/ActionHttp";

import {
  BuildFinished,
  FinishBuild,
  PipelineStatus,
  StartBuild,
  TailLog,
} from "./builds/Builds.js";
import { DeployRequested, RequestDeploy } from "./deploys/Deploys.js";
import { Login } from "./identity/Identity.js";

export const Http = ActionHttp.make(
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
