import * as Action from "@gjermundgaraba/effect-actions/Action";
import { Context, Effect, Layer, Redacted } from "effect";

import type { IssuerUnavailable, Member } from "./Identity.js";
import { members } from "./members.js";

/**
 * Who a credential names. It is a startup service: the verifiers yield it once, when their
 * layer is built, and call it per request.
 */
export class Directory extends Context.Service<
  Directory,
  {
    /** Every membership of the account an access token was issued to. */
    readonly ofToken: (
      token: Redacted.Redacted
    ) => Effect.Effect<
      readonly Member[],
      Action.Unauthenticated | IssuerUnavailable
    >;
    /** The member a web session was opened for: a session belongs to one workspace. */
    readonly ofSession: (
      session: Redacted.Redacted
    ) => Effect.Effect<Member, Action.Unauthenticated>;
  }
>()("tracker/Directory") {
  // DEMO ONLY: a token is an account's name (`ada`, `linus`, `kay`, `grace`) and a session a fixed
  // string. A real directory checks a signed token with the authorization server's library,
  // its audience included, failing with `IssuerUnavailable` when it cannot reach its keys, and
  // reads sessions from their store.
  static readonly layerDemo = Layer.sync(Directory, () => {
    const accounts = new Map<string, readonly Member[]>([
      ["ada", [members.ada, members.adaAtGlobex]],
      ["linus", [members.linus]],
      ["kay", [members.kay]],
      ["grace", [members.grace]],
    ]);

    const sessions = new Map<string, Member>([
      ["ada-at-acme", members.ada],
      ["kay-at-acme", members.kay],
      ["grace-at-globex", members.grace],
    ]);

    return Directory.of({
      ofToken: (token) =>
        Effect.fromNullishOr(accounts.get(Redacted.value(token))).pipe(
          Effect.mapError(
            () => new Action.Unauthenticated({ message: "Unknown demo token." })
          )
        ),
      ofSession: (session) =>
        Effect.fromNullishOr(sessions.get(Redacted.value(session))).pipe(
          Effect.mapError(
            () =>
              new Action.Unauthenticated({ message: "Unknown demo session." })
          )
        ),
    });
  });
}
