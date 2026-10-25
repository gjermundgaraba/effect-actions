import { Context, Schema } from "effect";
import * as Authentication from "@gjermundgaraba/effect-actions/Authentication";

/** A member, and the pipelines whose builds it may see. */
export const Member = Schema.Struct({
  id: Schema.String,
  pipelines: Schema.Array(Schema.String),
});

export type Member = typeof Member.Type;

/**
 * Who is subscribing or calling. Every event and action here declares it, `caller:
 * CurrentMember`; authentication provides it per request.
 */
export class CurrentMember extends Context.Service<CurrentMember, Member>()(
  "build-events/CurrentMember",
) {}

// How a remote caller proves it is a member: a bearer token. Clients import this descriptor
// with the contracts; its verifier stays on the server. `principal` names a member as one
// subscriber: a poll arrives as a request among others, and a surface keys what it holds
// between polls, deploy.requested's standing by, by it. Without it, MCP and HTTP refuse to
// serve that event, and no event is offered by webhook. `schema` keeps a webhook subscriber's
// identity, so the deliveries a restart restores run as that member.
export const Login = Authentication.make("build-events.Login", CurrentMember, {
  principal: (member) => member.id,
  schema: Member,
});
