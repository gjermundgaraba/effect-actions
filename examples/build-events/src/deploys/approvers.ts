import { Context, Effect, Layer } from "effect";
import type { Scope } from "effect";

import type { Environment } from "./Deploys.js";

export class Approvers extends Context.Service<
  Approvers,
  {
    readonly standBy: (
      environment: Environment | undefined,
      member: string
    ) => Effect.Effect<void, never, Scope.Scope>;
    readonly standingBy: (
      environment: Environment
    ) => Effect.Effect<readonly string[]>;
  }
>()("build-events/Approvers") {
  static readonly layerMemory = Layer.sync(Approvers, () => {
    const approvers: Array<{
      readonly environment: Environment | undefined;
      readonly member: string;
    }> = [];

    return Approvers.of({
      standBy: (environment, member) =>
        Effect.acquireRelease(
          Effect.sync(() => {
            const standing = { environment, member };

            approvers.push(standing);

            return standing;
          }),
          (standing) =>
            Effect.sync(() => approvers.splice(approvers.indexOf(standing), 1))
        ),
      standingBy: (environment) =>
        Effect.sync(() => [
          ...new Set(
            approvers
              .values()
              .filter(
                (each) =>
                  each.environment === undefined ||
                  each.environment === environment
              )
              .map((each) => each.member)
          ),
        ]),
    });
  });
}
