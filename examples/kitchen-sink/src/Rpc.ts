import * as ActionRpc from "@gjermundgaraba/effect-actions/ActionRpc";
import { MemberActions } from "./Actions.js";
import { QuotaExceeded, Session } from "./identity/Identity.js";

// The web app's binding: the members' actions as Effect RPC, one native rpc per action, over
// one WebSocket. Browser-safe, as the HTTP binding is. It names the other descriptor of the
// same identity: a page proves who it is with its session cookie, which the browser sends on
// the socket's upgrade. Its `error` is what the layer's middleware, the quota, fails with.
export const Rpc = ActionRpc.make(MemberActions, {
  authentication: Session,
  error: QuotaExceeded,
});
