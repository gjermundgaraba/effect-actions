import * as Action from "@gjermundgaraba/effect-actions/Action";
import * as Authentication from "@gjermundgaraba/effect-actions/Authentication";
import { Context, Schema } from "effect";

export const scopes = { read: "notes:read", write: "notes:write" } as const;

export const Scope = Schema.Literals([scopes.read, scopes.write]);

export interface User {
  readonly id: string;
  readonly scopes: ReadonlyArray<typeof Scope.Type>;
}

export class CurrentUser extends Context.Service<CurrentUser, User>()(
  "notes-service/CurrentUser"
) {}

export const Login = Authentication.make("notes-service.Login", CurrentUser);

export const WhoAmI = Action.make("whoAmI", {
  description: "Show who the credential identifies and which scopes it holds.",
  success: { id: Schema.String, scopes: Schema.Array(Scope) },
  readOnly: true,
  caller: CurrentUser,
});
