import { Context, Effect, Layer } from "effect";

import type { Build } from "../builds/Builds.js";

export class Notices extends Context.Service<
  Notices,
  {
    readonly add: (build: Build) => Effect.Effect<void>;
    readonly all: Effect.Effect<readonly Build[]>;
  }
>()("build-events/Notices") {
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
