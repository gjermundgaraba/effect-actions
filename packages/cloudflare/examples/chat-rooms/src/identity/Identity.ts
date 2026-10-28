import * as Authentication from "@gjermundgaraba/effect-actions/Authentication";
import { Context, Schema } from "effect";

export const Member = Schema.Struct({
  id: Schema.String,
  rooms: Schema.Array(Schema.String),
});

export type Member = typeof Member.Type;

export class CurrentMember extends Context.Service<CurrentMember, Member>()(
  "chat-rooms/CurrentMember"
) {}

export const Login = Authentication.make("chat-rooms.Login", CurrentMember);
