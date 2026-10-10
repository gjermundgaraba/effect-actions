import { Context, Effect, Layer, Redacted } from "effect";
import { Command } from "effect/cli";
import * as Action from "@gjermundgaraba/effect-actions/Action";
import * as ActionCli from "@gjermundgaraba/effect-actions/ActionCli";
import * as ActionHttp from "@gjermundgaraba/effect-actions/ActionHttp";
import * as Authentication from "@gjermundgaraba/effect-actions/Authentication";

/** What a verified token can name. */
export interface RemoteOperator {
  readonly id: string;
  readonly role: "viewer" | "editor";
}

/** What only a host supplies: no verifier returns one. */
export interface TrustedOperator {
  readonly id: string;
  readonly role: "trusted";
}

export class Operator extends Context.Service<Operator, RemoteOperator | TrustedOperator>()(
  "example/Operator",
) {}

export const Purge = Action.make("purge", {
  description: "Purge the cache.",
  readOnly: false,
  caller: Operator,
});

// One rule for every caller: a trusted operator passes, a remote one needs the editor role.
export const cache = Action.implement(Purge, () => Effect.log("Purged."), {
  authorize: (action) =>
    Effect.gen(function* () {
      const operator = yield* Operator;

      if (operator.role === "trusted") return;

      if (!action.readOnly && operator.role !== "editor") {
        return yield* new Action.Forbidden({ message: "Requires the editor role." });
      }
    }),
});

const OperatorLogin = Authentication.make("example.OperatorLogin", Operator);

export const Http = ActionHttp.make([Purge], { authentication: OperatorLogin });

// DEMO ONLY: a token is a role. Typed as the remote subset, so no token, and no claim mapped
// onto `role`, can name the trusted operator.
const verify = (
  token: Redacted.Redacted<string>,
): Effect.Effect<RemoteOperator, Action.Unauthenticated> => {
  const role = Redacted.value(token);

  return role === "viewer" || role === "editor"
    ? Effect.succeed({ id: role, role })
    : Effect.fail(new Action.Unauthenticated({ message: "Unknown demo token." }));
};

export const routes = ActionHttp.layer(Http, cache).pipe(
  Layer.provide(Authentication.layer(OperatorLogin, verify)),
);

const operator: TrustedOperator = { id: "ops", role: "trusted" };

// The host's own command, `ops purge`: the same implementation and rule, run as the trusted
// operator the host supplies. Nothing remote can reach it.
export const cli = ActionCli.make(cache, { name: "ops" }).pipe(
  Command.provideSync(Operator, operator),
);
