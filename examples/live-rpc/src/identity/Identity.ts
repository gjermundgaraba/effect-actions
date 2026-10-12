import { Context } from "effect";
import * as Authentication from "@gjermundgaraba/effect-actions/Authentication";

export interface Member {
  readonly id: string;
  readonly rooms: ReadonlyArray<string>;
}

/**
 * Who sent a message. A protected action declares it, `caller: CurrentMember`; authentication
 * provides it for each message, and a test calling in process provides it itself.
 */
export class CurrentMember extends Context.Service<CurrentMember, Member>()(
  "live-rpc/CurrentMember",
) {}

// How a remote caller proves it is CurrentMember: a bearer token, the default scheme. Clients
// import this descriptor with the binding; its verifier, in verifier.ts, stays on the server.
export const Login = Authentication.make("live-rpc.Login", CurrentMember);
