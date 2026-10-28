import * as Action from "@gjermundgaraba/effect-actions/Action";
import { Context, Schema } from "effect";

export interface Member {
  readonly kind: "member";
  readonly id: string;
}

export interface Operator {
  readonly kind: "operator";
  readonly id: string;
}

export class CurrentCaller extends Context.Service<
  CurrentCaller,
  Member | Operator
>()("assistant/CurrentCaller") {}

export const WhoAmI = Action.make("whoAmI", {
  description: "Show who the assistant is acting for.",
  success: { id: Schema.String, kind: Schema.Literals(["member", "operator"]) },
  readOnly: true,
  caller: CurrentCaller,
});
