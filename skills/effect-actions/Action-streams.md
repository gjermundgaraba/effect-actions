# Progress and streamed answers

An action answers once, at the end. Two options let a caller see more while it runs: `progress`, values the handler reports along the way, which a caller may miss some of, and `Action.Stream`, an answer of many elements, each arriving as it is produced. Both are declared on the contract ([Action.md](Action.md#define-a-contract)) and carried by every surface its own way: the declaration's JSDoc says how.

A message the library throws says its fix; for a compiler diagnostic or Effect's own error, search [Action-failures.md](Action-failures.md). For one symbol, `grep -rn <symbol> node_modules/@gjermundgaraba/effect-actions/dist/`.

## Report progress

An action declaring `progress`, a schema or struct fields, gets a second argument in its handler, `{ progress }`, which reports a value to the caller without waiting for it; a client's call takes `{ onProgress }` after its input ([build-events/test/builds/progress.test.ts](node_modules/@gjermundgaraba/effect-actions/examples/build-events/test/builds/progress.test.ts)). The contract is `StartBuild` in [build-events/src/builds/Builds.ts](node_modules/@gjermundgaraba/effect-actions/examples/build-events/src/builds/Builds.ts).

```ts example=build-events/src/builds/handlers.ts
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

const steps = ["install", "build", "test"];

export const builds = Action.implement(
  [FinishBuild, StartBuild],
  Effect.gen(function* () {
    const store = yield* BuildStore;
    const events = yield* Event.Events;

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
```

The rules are on `Action.Options.progress`; how each surface carries the values, on `ActionHttp.layer`, `ActionRpc.make`, `ActionMcp.layerHttp`, `ActionToolkit.make` and `ActionCli.command`.

- **Report a snapshot to show, never an event to count.** A caller falling behind loses the oldest values, never the answer: what a caller must receive each time is the answer, or an [event](Event.md).

## Answer a stream

An action whose `success` is `Action.Stream(element)` has a handler returning a `Stream` of elements, and every client's call returns one ([build-events/test/builds/log.test.ts](node_modules/@gjermundgaraba/effect-actions/examples/build-events/test/builds/log.test.ts)). The contract is `TailLog` in [Builds.ts](node_modules/@gjermundgaraba/effect-actions/examples/build-events/src/builds/Builds.ts).

```ts example=build-events/src/builds/log.ts
import * as Action from "@gjermundgaraba/effect-actions/Action";
import { Effect, Stream } from "effect";

import { CurrentMember } from "../identity/Identity.js";
import { TailLog } from "./Builds.js";
import { BuildStore } from "./store.js";

export const logs = Action.implement(
  TailLog,
  Effect.gen(function* () {
    const store = yield* BuildStore;

    return ({ buildId }) =>
      Stream.unwrap(
        Effect.gen(function* () {
          const member = yield* CurrentMember;
          const log = yield* store.logOf(member.pipelines, buildId);

          return Stream.fromIterable(log.map((line) => ({ line })));
        })
      );
  }),
  { authorize: Action.allowAll }
);
```

How each surface carries it is on `ActionHttp.layer`, `ActionRpc.make`, `ActionMcp.layerHttp`, `ActionToolkit.make` and `ActionCli.command`.

- **A tool collects it whole.** A tool answers one result, so an MCP endpoint and a toolkit answer the elements as one array once the stream ends, and `ActionMcp.client`'s method streams that array again: a stream that never ends never answers a tool, and a long one fills a model's context, so [kitchen-sink/src/Actions.ts](node_modules/@gjermundgaraba/effect-actions/examples/kitchen-sink/src/Actions.ts) leaves `exportIssues` out of its tools.
