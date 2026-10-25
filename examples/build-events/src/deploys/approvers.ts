import { Context, Effect, Layer, type Scope } from "effect";
import type { Environment } from "./Deploys.js";

/** Who stands by to approve deploys, and to which environment. */
export class Approvers extends Context.Service<
  Approvers,
  {
    /** Stands `member` by to approve deploys to `environment`, every one where undefined, until the scope closes. */
    readonly standBy: (
      environment: Environment | undefined,
      member: string,
    ) => Effect.Effect<void, never, Scope.Scope>;
    readonly standingBy: (environment: Environment) => Effect.Effect<ReadonlyArray<string>>;
  }
>()("build-events/Approvers") {
  // DEMO ONLY: approvers live in this process's memory, where a real one is a rota in a store.
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
          (standing) => Effect.sync(() => approvers.splice(approvers.indexOf(standing), 1)),
        ),
      standingBy: (environment) =>
        Effect.sync(() => [
          ...new Set(
            approvers
              .filter((each) => each.environment === undefined || each.environment === environment)
              .map((each) => each.member),
          ),
        ]),
    });
  });
}
