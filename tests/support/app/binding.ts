import * as ActionHttp from "@gjermundgaraba/effect-actions/ActionHttp";
import * as Authentication from "@gjermundgaraba/effect-actions/Authentication";
import { CurrentActor } from "./authorization.js";
import { Double, GetUser, RenameUser, Status, WhoAmI } from "./contracts.js";

export const Login = Authentication.make("example.Login", CurrentActor);

export const Http = ActionHttp.make([Status, GetUser, RenameUser, Double, WhoAmI], {
  authentication: Login,
});
