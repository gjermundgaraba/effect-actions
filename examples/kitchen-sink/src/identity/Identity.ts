import * as Action from "@gjermundgaraba/effect-actions/Action";
import * as Authentication from "@gjermundgaraba/effect-actions/Authentication";
import { Context, Schema } from "effect";
import { HttpApiSecurity } from "effect/http-api";

export const scopes = { read: "issues:read", write: "issues:write" } as const;

export const Scope = Schema.Literals([scopes.read, scopes.write]);

export interface Member {
  readonly id: string;
  readonly workspace: string;
  readonly scopes: ReadonlyArray<typeof Scope.Type>;
}

export class CurrentMember extends Context.Service<CurrentMember, Member>()(
  "tracker/CurrentMember"
) {}

export class IssuerUnavailable extends Schema.TaggedError<
  IssuerUnavailable,
  { readonly brand: unique symbol }
>()(
  "IssuerUnavailable",
  { retryAfterSeconds: Schema.Finite },
  { httpApiStatus: 503 }
) {}

export const Login = Authentication.make("tracker.Login", CurrentMember, {
  error: IssuerUnavailable,
  principal: (member) => JSON.stringify([member.workspace, member.id]),
});

export const Session = Authentication.make("tracker.Session", CurrentMember, {
  security: HttpApiSecurity.apiKey({ in: "cookie", key: "tracker_session" }),
});

export class QuotaExceeded extends Schema.TaggedError<
  QuotaExceeded,
  { readonly brand: unique symbol }
>()(
  "QuotaExceeded",
  { retryAfterSeconds: Schema.Finite },
  { httpApiStatus: 429 }
) {}

export const WhoAmI = Action.make("whoAmI", {
  description:
    "Show who the credential identifies, in which workspace, with which scopes.",
  success: {
    id: Schema.String,
    workspace: Schema.String,
    scopes: Schema.Array(Scope),
  },
  readOnly: true,
  caller: CurrentMember,
});
