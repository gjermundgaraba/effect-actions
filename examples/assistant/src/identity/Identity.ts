import { Context, Schema } from "effect";
import * as Action from "@gjermundgaraba/effect-actions/Action";

/** A teammate: what a sign-in can name. The assistant acts for one in each turn. */
export interface Member {
  readonly kind: "member";
  readonly id: string;
}

/**
 * Whoever runs the machine. Only a host builds one, in its own code: nothing that turns a
 * credential into a caller is typed to return it, so no token can claim to be the operator.
 */
export interface Operator {
  readonly kind: "operator";
  readonly id: string;
}

/**
 * Who is calling. A protected action declares it, `caller: CurrentCaller`. Nothing here
 * authenticates anyone: the host provides it around each call, as the member a model acts for
 * or as the operator at the terminal.
 */
export class CurrentCaller extends Context.Service<CurrentCaller, Member | Operator>()(
  "assistant/CurrentCaller",
) {}

export const WhoAmI = Action.make("whoAmI", {
  description: "Show who the assistant is acting for.",
  success: { id: Schema.String, kind: Schema.Literals(["member", "operator"]) },
  readOnly: true,
  caller: CurrentCaller,
});
