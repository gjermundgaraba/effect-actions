import * as Authentication from "@gjermundgaraba/effect-actions/Authentication";
import { Context } from "effect";

export interface Member {
  readonly id: string;
  readonly rooms: readonly string[];
}

export class CurrentMember extends Context.Service<CurrentMember, Member>()(
  "live-rpc/CurrentMember"
) {}

export const Login = Authentication.make("live-rpc.Login", CurrentMember);
