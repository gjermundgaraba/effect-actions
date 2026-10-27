import * as ActionHttp from "@gjermundgaraba/effect-actions/ActionHttp";

import { MemberActions } from "./Actions.js";
import { Admin, OperatorKey } from "./admin/Admin.js";
import { Login, QuotaExceeded } from "./identity/Identity.js";
import { IssueChanged } from "./issues/Issues.js";
import { GetStatus } from "./workspaces/Workspaces.js";

// The members' HTTP binding: every action at `POST /api/v1/<name>`, and `issue.changed` at
// `POST /api/v1/events/issue.changed`, polled or held open as a stream. It is plain data and
// imports no server code, so the server, the CLI, the SDK and a test all import this one value.
// - `authentication`: how the protected actions' caller proves who it is. `getStatus` is public.
// - `error`: the quota middleware's, so a client decodes its 429 as a typed `QuotaExceeded`.
export const Http = ActionHttp.make(
  [GetStatus, ...MemberActions, IssueChanged],
  {
    prefix: "/api/v1",
    authentication: Login,
    error: QuotaExceeded,
  }
);

// The operators' binding: other actions, another identity, another descriptor, served on a port
// of its own.
// The public `getStatus` is bound here too: one contract, one implementation, on both ports.
export const AdminHttp = ActionHttp.make([GetStatus, ...Admin], {
  prefix: "/admin",
  authentication: OperatorKey,
});
