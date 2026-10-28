import * as Authentication from "@gjermundgaraba/effect-actions/Authentication";
import { Context, Schema } from "effect";

export const Member = Schema.Struct({
  id: Schema.String,
  pipelines: Schema.Array(Schema.String),
});

export type Member = typeof Member.Type;

export class CurrentMember extends Context.Service<CurrentMember, Member>()(
  "build-events/CurrentMember"
) {}

export const Login = Authentication.make("build-events.Login", CurrentMember, {
  principal: (member) => member.id,
  schema: Member,
});
