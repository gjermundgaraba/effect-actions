import { Context, Schema } from "effect";
import { HttpApiSecurity } from "effect/http-api";
import * as Action from "@gjermundgaraba/effect-actions/Action";
import * as Authentication from "@gjermundgaraba/effect-actions/Authentication";

export const scopes = { read: "issues:read", write: "issues:write" } as const;

export const Scope = Schema.Literals([scopes.read, scopes.write]);

/** A person acting in one workspace, with the scopes their credential holds there. */
export interface Member {
  readonly id: string;
  readonly workspace: string;
  readonly scopes: ReadonlyArray<typeof Scope.Type>;
}

/**
 * Who is calling. A protected action declares it, `caller: CurrentMember`; authentication
 * provides it per request, and a local host (stdio, the assistant, a test) provides it itself.
 */
export class CurrentMember extends Context.Service<CurrentMember, Member>()(
  "tracker/CurrentMember",
) {}

// What a verifier may fail with besides a refusal: the issuer it checks tokens with is down.
// It is not the caller's fault, so it is no 401: signing in again cannot help.
export class IssuerUnavailable extends Schema.TaggedError<IssuerUnavailable>()(
  "IssuerUnavailable",
  { retryAfterSeconds: Schema.Finite },
  { httpApiStatus: 503 },
) {}

// How an API client, the CLI and an MCP client prove they are CurrentMember: a bearer token,
// the default scheme. `principal` names one subscriber, for what MCP and HTTP hold between its
// requests, such as its webhook subscriptions: a member of two workspaces is two subscribers,
// so it names the workspace too, encoded so no two pairs spell one principal.
export const Login = Authentication.make("tracker.Login", CurrentMember, {
  error: IssuerUnavailable,
  principal: (member) => JSON.stringify([member.workspace, member.id]),
});

// How the web app proves the same identity: the session cookie its sign-in page set. It is
// named by what accepts it: `Rpc`, the web app's socket, and the route its pages load an
// attachment's image from.
export const Session = Authentication.make("tracker.Session", CurrentMember, {
  security: HttpApiSecurity.apiKey({ in: "cookie", key: "tracker_session" }),
});

// What the API's request quota answers with. It is the bindings' error, not an action's:
// middleware sends it on any action's route, before its input is decoded. Only HTTP and RPC
// have that middleware.
export class QuotaExceeded extends Schema.TaggedError<QuotaExceeded>()(
  "QuotaExceeded",
  { retryAfterSeconds: Schema.Finite },
  { httpApiStatus: 429 },
) {}

// An action without input: its client method takes no argument, its command no flag.
export const WhoAmI = Action.make("whoAmI", {
  description: "Show who the credential identifies, in which workspace, with which scopes.",
  success: { id: Schema.String, workspace: Schema.String, scopes: Schema.Array(Scope) },
  readOnly: true,
  caller: CurrentMember,
});
