import * as Authentication from "@gjermundgaraba/effect-actions/Authentication";
import { Context, Schema } from "effect";

export const Member = Schema.Struct({
  id: Schema.String,
  rooms: Schema.Array(Schema.String),
});

export type Member = typeof Member.Type;

/**
 * Who sent a message. A protected action declares it, `caller: CurrentMember`; authentication
 * provides it for each message, from the token the message carries or the one its socket kept.
 */
export class CurrentMember extends Context.Service<CurrentMember, Member>()(
  "chat-rooms/CurrentMember"
) {}

// How a remote caller proves it is CurrentMember: a bearer token, the default scheme. Clients
// import this descriptor with the bindings; its verifier, in verifier.ts, stays on the server.
export const Login = Authentication.make("chat-rooms.Login", CurrentMember);
