import * as Action from "@gjermundgaraba/effect-actions/Action";
import { Context, Effect, Layer, Redacted } from "effect";

import type { IssuerUnavailable, Member } from "./Identity.js";
import { demoMembers } from "./members.js";

export class Directory extends Context.Service<
  Directory,
  {
    readonly ofToken: (
      token: Redacted.Redacted
    ) => Effect.Effect<
      readonly Member[],
      Action.Unauthenticated | IssuerUnavailable
    >;
    readonly ofSession: (
      session: Redacted.Redacted
    ) => Effect.Effect<Member, Action.Unauthenticated>;
  }
>()("tracker/Directory") {
  static readonly layerDemo = Layer.sync(Directory, () => {
    const accounts = new Map<string, readonly Member[]>([
      ["ada", [demoMembers.ada, demoMembers.adaAtGlobex]],
      ["linus", [demoMembers.linus]],
      ["kay", [demoMembers.kay]],
      ["grace", [demoMembers.grace]],
    ]);

    const sessions = new Map<string, Member>([
      ["ada-at-acme", demoMembers.ada],
      ["kay-at-acme", demoMembers.kay],
      ["grace-at-globex", demoMembers.grace],
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
