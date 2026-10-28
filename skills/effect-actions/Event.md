# Event

`Event.make` defines an event type: something that happens, which subscribers receive as it happens, each subscription selecting with its own arguments. `Event.implement` binds it to the source its occurrences come from, behind an authorizer. Event implementations go in the same list as action implementations: `Action.client` watches them in process; an MCP endpoint ([ActionMcp.md](ActionMcp.md#serve-events)), HTTP routes ([ActionHttp.md](ActionHttp.md#serve-and-watch-events)) and rpcs ([ActionRpc-events.md](ActionRpc-events.md)) serve them; a server POSTs them to a subscriber's callback by webhook ([Webhook.md](Webhook.md)); and a CLI watches them ([ActionCli.md](ActionCli.md#watch-events)). Events are experimental: their surfaces follow MCP's events extension, SEP-3415, a draft, and may change with it.

A message the library throws says its fix; for a compiler diagnostic or Effect's own error, search [Event-failures.md](Event-failures.md). For one symbol, `grep -rn <symbol> node_modules/@gjermundgaraba/effect-actions/dist/`: each declaration's JSDoc carries its rules and gotchas, and this page only what an example cannot show.

## Define an event type

One `Event.make` per event type, in the domain's contract file, beside its actions: `input` is what a subscription takes, `payload` what each occurrence carries, and `caller` who may subscribe, as on an action ([Action.md](Action.md#say-who-may-call-an-action)).

```ts example=build-events/src/builds/Builds.ts
import * as Action from "@gjermundgaraba/effect-actions/Action";
import * as Event from "@gjermundgaraba/effect-actions/Event";
import { Schema } from "effect";

import { CurrentMember } from "../identity/Identity.js";

const Pipeline = Schema.String.annotate({
  description: "A pipeline's name, such as api.",
});

const Status = Schema.Literals(["passed", "failed"]).annotate({
  description: "How the build ended.",
});

export const Build = Schema.Struct({
  id: Schema.String,
  pipeline: Pipeline,
  status: Status,
});

export type Build = typeof Build.Type;

export const FinishBuild = Action.make("finishBuild", {
  description: "Record that a build of a pipeline finished.",
  input: { pipeline: Pipeline, status: Status },
  success: Build,
  readOnly: false,
  caller: CurrentMember,
});

export const StartBuild = Action.make("startBuild", {
  description:
    "Run a build of a pipeline, reporting each step, and record how it ended.",
  input: { pipeline: Pipeline },
  success: Build,
  progress: {
    step: Schema.String.annotate({
      description: "The step that started, such as test.",
    }),
    done: Schema.Finite.annotate({
      description: "How many steps finished before it.",
    }),
    total: Schema.Finite.annotate({
      description: "How many steps the build has.",
    }),
  },
  readOnly: false,
  caller: CurrentMember,
});

export class BuildNotFound extends Schema.TaggedError<
  BuildNotFound,
  { readonly brand: unique symbol }
>()("BuildNotFound", { buildId: Schema.String }, { httpApiStatus: 404 }) {}

export const TailLog = Action.make("tailLog", {
  description: "Stream a build's log, line by line.",
  input: {
    buildId: Schema.String.annotate({
      description: "The build's id, such as build-1.",
    }),
  },
  success: Action.Stream({ line: Schema.String }),
  error: BuildNotFound,
  readOnly: true,
  caller: CurrentMember,
});

export const BuildFinished = Event.make("build.finished", {
  description: "A build of a pipeline you may see finished.",
  input: {
    pipeline: Schema.optional(Pipeline).annotate({
      description: "Only this pipeline's builds.",
    }),
    status: Schema.optional(Status).annotate({
      description: "Only builds that ended so.",
    }),
  },
  payload: Build,
  caller: CurrentMember,
});

export const PipelineStatus = Event.make("pipeline.status", {
  description:
    "How a pipeline's last build ended: first as it is, then each time one finishes.",
  input: { pipeline: Pipeline },
  payload: {
    status: Schema.NullOr(Status).annotate({
      description: "How it ended; null before any did.",
    }),
  },
  caller: CurrentMember,
});
```

The name's form is in the message `Invalid event name` throws. A contract says nothing about how it is delivered: each surface decides that, as it decides an action's route.

## Read from an upstream you can ask

When the upstream can be asked what happened since a position, such as a table with a sequence column, a change feed or a history API, give `check`: one function, from the subscription's input and a cursor to the occurrences since it and the cursor after them. It answers every subscriber, one that polls and one that holds a stream open alike, running as that subscriber.

```ts example=build-events/src/builds/events.ts
import * as Event from "@gjermundgaraba/effect-actions/Event";
import { Effect } from "effect";

import { CurrentMember } from "../identity/Identity.js";
import { BuildFinished } from "./Builds.js";
import { BuildStore } from "./store.js";

export const buildEvents = Event.implement(
  BuildFinished,
  Effect.gen(function* () {
    const store = yield* BuildStore;

    return {
      check: ({ pipeline, status }, cursor) =>
        Effect.gen(function* () {
          const member = yield* CurrentMember;

          const page = yield* store.finishedSince(
            member.pipelines,
            cursor,
            100
          );

          return {
            cursor: page.cursor,
            hasMore: page.hasMore,
            truncated: page.truncated,
            events: page.builds
              .filter(
                (build) => pipeline === undefined || build.pipeline === pipeline
              )
              .filter(
                (build) => status === undefined || build.status === status
              )
              .map((build) => ({
                eventId: `${page.epoch}/${build.id}`,
                data: build,
              })),
          };
        }),
    };
  }),
  { authorize: Event.allowAll }
);
```

[build-events/src/builds/store.ts](node_modules/@gjermundgaraba/effect-actions/examples/build-events/src/builds/store.ts) is the store. What a check answers for a first subscription and a stale cursor is on `Event.Page`; the rest of a check's rules are on `Event.Check`.

A subscriber holding a stream open is read again every 5 seconds. Where the application writes the store itself, it wakes them at once: after the write, `Event.Events`' `notify`, as [build-events/src/builds/handlers.ts](node_modules/@gjermundgaraba/effect-actions/examples/build-events/src/builds/handlers.ts) does after each build finishes. A store another process writes is read at the next poll; when a Durable Object reads it is on the Cloudflare package's `ActionDurableObject.handlers`.

- **Check what a subscriber may see where the data is read**, as an action's handler does: `authorize` decides whether it may subscribe at all, and receives the event type, not the subscription's input.

## Send a value whole

When an occurrence is the whole value, such as a status or a list small enough to send whole, give `current`: the value as it is, for the subscription's input. A subscriber is sent it first, then again after each `notify` that reaches its key, never each change it missed one by one: the library keeps the revision that is its cursor, so the store keeps none.

```ts example=build-events/src/builds/status.ts
import * as Event from "@gjermundgaraba/effect-actions/Event";
import { Effect } from "effect";

import { CurrentMember } from "../identity/Identity.js";
import { PipelineStatus } from "./Builds.js";
import { BuildStore } from "./store.js";

export const statusEvents = Event.implement(
  PipelineStatus,
  Effect.gen(function* () {
    const store = yield* BuildStore;

    return {
      current: ({ pipeline }) =>
        Effect.gen(function* () {
          const member = yield* CurrentMember;

          return { status: yield* store.statusOf(member.pipelines, pipeline) };
        }),
      key: ({ pipeline }) => pipeline,
    };
  }),
  { authorize: Event.allowAll }
);
```

[build-events/src/builds/handlers.ts](node_modules/@gjermundgaraba/effect-actions/examples/build-events/src/builds/handlers.ts) notifies after each build with its pipeline as the key, so a build wakes only that pipeline's subscribers. What a notify without a change sends, and why a value written as it is read is not missed, is on `Event.Current`.

## Keep what nothing else keeps

When no store keeps the occurrences, such as a request made and answered at once or an upstream that only pushes, give `log`: the library keeps each occurrence published to it for subscribers resuming from a cursor, and gives each subscriber what its `match` accepts, shaped by its `transform`.

```ts example=build-events/src/deploys/events.ts
import * as Event from "@gjermundgaraba/effect-actions/Event";
import { Effect } from "effect";

import { CurrentMember } from "../identity/Identity.js";
import { Approvers } from "./approvers.js";
import { DeployRequested } from "./Deploys.js";

export const deployEvents = Event.implement(
  DeployRequested,
  Effect.gen(function* () {
    const approvers = yield* Approvers;

    return {
      log: {},
      match: ({ environment }, deploy) =>
        environment === undefined || deploy.environment === environment,
      subscription: ({ environment }) =>
        Effect.flatMap(CurrentMember, (member) =>
          approvers.standBy(environment, member.id)
        ),
    };
  }),
  { authorize: Event.allowAll }
);
```

The action publishes each request with `Event.Events`' `publish`, in [build-events/src/deploys/handlers.ts](node_modules/@gjermundgaraba/effect-actions/examples/build-events/src/deploys/handlers.ts). An upstream that is a stream, such as a message bus, gives it as `log.emit`, each occurrence with the `key` `publish` would take, which the library consumes from the start of a surface serving its event type: kitchen-sink's [issues/events.ts](node_modules/@gjermundgaraba/effect-actions/examples/kitchen-sink/src/issues/events.ts). How much the log keeps, and what a cursor from another process or a restart reads as, are on `Event.Log`.

- **Prefer `check` wherever the upstream keeps a cursor of its own**: a subscriber then resumes after a restart without a gap.

## Set up a subscription upstream

When each subscription needs something set up upstream while it lasts, such as joining the channel it watches, give the source a `subscription`, as `deployEvents` above does: a scoped Effect, whose finalizer tears it down, run as the subscriber. How long it lasts is on the `subscription` option of `Event.Check` and `Event.Log`.

## Announce to the subscribers

`Event.Events` is where occurrences are announced as they happen: `notify` for a check source, `publish` for a log source. Domain code yields it as it yields a store, and the entrypoint provides one, `Event.layerMemory`, around both the handlers that announce and the surfaces that serve, as [build-events/src/server.ts](node_modules/@gjermundgaraba/effect-actions/examples/build-events/src/server.ts) does; a host keeping logs elsewhere builds its own with `Event.makeEvents`, as the Cloudflare package's `ActionDurableObject.make` does. A source's `key`, such as the room a subscriber follows, lets an announcement given that key reach that room's subscribers alone, as [live-rpc/src/chat/events.ts](node_modules/@gjermundgaraba/effect-actions/examples/live-rpc/src/chat/events.ts) keys its messages by room. The rules are on `Event.Events`.

## Watch in process

`Action.client` given event implementations has `watch(event, input, options)`: a `Stream` of `Event.Received`, the occurrences and a `Gap` wherever some were missed, owing per subscription what an action's call owes. [Testing.md](Testing.md#test-events) watches one in a test.
