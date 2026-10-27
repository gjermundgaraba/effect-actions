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

// The HTTP binding: each action at `POST /api/<name>`, and each event at
// `POST /api/events/<name>`, which answers a page of JSON, or, asked for `text/event-stream`,
// holds a stream open. It imports no server code, so a client imports it with the contracts.
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
