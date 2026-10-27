import * as Action from "@gjermundgaraba/effect-actions/Action";
import * as Authentication from "@gjermundgaraba/effect-actions/Authentication";
import { Context, Schema } from "effect";

export const scopes = { read: "notes:read", write: "notes:write" } as const;

export const Scope = Schema.Literals([scopes.read, scopes.write]);

export interface User {
  readonly id: string;
  readonly scopes: ReadonlyArray<typeof Scope.Type>;
}

/**
 * Who is calling. A protected action declares it, `caller: CurrentUser`; authentication
 * provides it per request, and a local host, such as the stdio server, provides it itself.
 */
export class CurrentUser extends Context.Service<CurrentUser, User>()(
  "notes-service/CurrentUser"
) {}

// How a remote caller proves it is CurrentUser: a bearer token, the default scheme. Clients
// import this descriptor with the binding; its verifier, in verifier.ts, stays on the server.
export const Login = Authentication.make("notes-service.Login", CurrentUser);

export const WhoAmI = Action.make("whoAmI", {
  description: "Show who the credential identifies and which scopes it holds.",
  success: { id: Schema.String, scopes: Schema.Array(Scope) },
  readOnly: true,
  caller: CurrentUser,
});
