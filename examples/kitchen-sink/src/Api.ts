import * as ActionHttp from "@gjermundgaraba/effect-actions/ActionHttp";

import { MemberActions } from "./Actions.js";
import { Admin, OperatorKey } from "./admin/Admin.js";
import { Login, QuotaExceeded } from "./identity/Identity.js";
import { IssueChanged } from "./issues/Issues.js";
import { GetStatus } from "./workspaces/Workspaces.js";

export const Http = ActionHttp.make(
  [GetStatus, ...MemberActions, IssueChanged],
  {
    prefix: "/api/v1",
    authentication: Login,
    error: QuotaExceeded,
  }
);

export const AdminHttp = ActionHttp.make([GetStatus, ...Admin], {
  prefix: "/admin",
  authentication: OperatorKey,
});
