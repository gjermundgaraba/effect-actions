import * as ActionHttp from "../src/ActionHttp.js";
import * as Authentication from "../src/Authentication.js";
import { CurrentActor } from "./authorization.js";
import { Double, GetUser, RenameUser, Status, WhoAmI } from "./contracts.js";

// Browser-safe: how a remote caller proves it is CurrentActor, a bearer token unless
// `security` names another native scheme. The verifier lives in authentication.ts. The literal
// name identifies the verifier that may provide it.
export const Login = Authentication.make("example.Login", CurrentActor);

// Protected contracts get native bearer security (enforced and documented); `status`,
// declared `caller: Action.Anyone`, gets none.
export const Http = ActionHttp.make([Status, GetUser, RenameUser, Double, WhoAmI], {
  authentication: Login,
});
