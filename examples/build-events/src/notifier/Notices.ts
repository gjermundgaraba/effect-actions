import { Context, Effect, Layer } from "effect";

import type { Build } from "../builds/Builds.js";

/** The failed builds the notifier was told of, in the order it was told. */
export class Notices extends Context.Service<
  Notices,
  {
    readonly add: (build: Build) => Effect.Effect<void>;
    readonly all: Effect.Effect<readonly Build[]>;
  }
>()("build-events/Notices") {
  // DEMO ONLY: notices live in this process's memory; a notifier sends each on, to a chat or a
  // pager, as it arrives.
  static readonly layerMemory = Layer.sync(Notices, () => {
    const notices: Build[] = [];

    return Notices.of({
      add: (build) =>
        Effect.sync(() => {
          notices.push(build);
        }),
      all: Effect.sync(() => [...notices]),
    });
  });
}
