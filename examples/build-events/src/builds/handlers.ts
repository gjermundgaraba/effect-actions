import * as Action from "@gjermundgaraba/effect-actions/Action";
import * as Event from "@gjermundgaraba/effect-actions/Event";
import { Effect } from "effect";

import {
  BuildFinished,
  FinishBuild,
  PipelineStatus,
  StartBuild,
} from "./Builds.js";
import type { Build } from "./Builds.js";
import { BuildStore } from "./store.js";

// DEMO ONLY: each step passes at once. A runner's steps take their time, which is why a caller
// wants to see them.
const steps = ["install", "build", "test"];

export const builds = Action.implement(
  [FinishBuild, StartBuild],
  Effect.gen(function* () {
    const store = yield* BuildStore;
    const events = yield* Event.Events;

    // `build.finished` is a check source over the store: write the build there first, then wake
    // its subscribers, who read it now rather than at their next poll. `pipeline.status` is a
    // current source: the notify moves its pipeline's revision, so its subscribers alone read it.
    const finished = (build: Effect.Effect<Build>) =>
      Effect.tap(build, ({ pipeline }) =>
        Effect.andThen(
          events.notify(BuildFinished),
          events.notify(PipelineStatus, { key: pipeline })
        )
      );

    return {
      finishBuild: ({ pipeline, status }) =>
        finished(store.finish(pipeline, status, [status])),
      // `progress` never waits for the caller: the build runs at its own pace.
      startBuild: ({ pipeline }, { progress }) =>
        Effect.andThen(
          Effect.forEach(
            steps,
            (step, done) => progress({ step, done, total: steps.length }),
            {
              discard: true,
            }
          ),
          finished(
            store.finish(pipeline, "passed", [
              ...steps.map((step) => `${step}: passed`),
              "passed",
            ])
          )
        ),
    };
  }),
  { authorize: Action.allowAll }
);
