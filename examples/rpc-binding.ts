import * as ActionRpc from "../src/ActionRpc.js";
import { Login } from "./binding.js";
import { GetUser, RenameUser, Status, WhoAmI } from "./contracts.js";

// Browser-safe, as the HTTP binding is: one native rpc per action, shared by the server and
// every client. Its protected rpcs authenticate with `Login`, the HTTP binding's descriptor,
// so one verifier serves both; `status` stays public.
export const Rpc = ActionRpc.make([Status, GetUser, RenameUser, WhoAmI], {
  authentication: Login,
});
