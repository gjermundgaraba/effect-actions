import * as ActionRpc from "@gjermundgaraba/effect-actions/ActionRpc";

import { MemberActions } from "./Actions.js";
import { QuotaExceeded, Session } from "./identity/Identity.js";
import { IssueChanged } from "./issues/Issues.js";

export const Rpc = ActionRpc.make([...MemberActions, IssueChanged], {
  authentication: Session,
  error: QuotaExceeded,
});
