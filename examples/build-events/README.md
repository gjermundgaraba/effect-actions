# build-events

A CI service whose events are watched by its members: `build.finished`, read from a store that
can be asked what finished since a cursor, and `deploy.requested`, published by the action that
requests a deploy, with no store to ask. Each member sees only the pipelines they may. It
implements both beside the actions that cause them, and watches them in process. Two actions
answer more than one value: `startBuild` reports progress as it runs, and `tailLog` answers a
stream of a build's log lines.

## Run it

From the repository root, after `vp install`:

```sh
vp test examples/build-events
```

## Layout

```text
src/
├── identity/
│   ├── Identity.ts    contract: CurrentMember
│   └── members.ts     the demo members
├── builds/
│   ├── Builds.ts      contract: the build schema, finishBuild, startBuild, tailLog and build.finished
│   ├── store.ts       BuildStore: finished builds read by cursor, its epoch, and its Layer
│   ├── handlers.ts    Action.implement: finishBuild, and startBuild reporting progress, each notifying build.finished
│   ├── log.ts         Action.implement: tailLog, answering a stream of log lines
│   └── events.ts      Event.implement: build.finished, a check source
├── deploys/
│   ├── Deploys.ts     contract: the deploy schema, requestDeploy and deploy.requested
│   ├── approvers.ts   Approvers: who stands by to approve deploys, and its Layer
│   ├── handlers.ts    Action.implement: requestDeploy, publishing deploy.requested
│   └── events.ts      Event.implement: deploy.requested, a log source with a subscription hook
test/
├── support/           as: the caller of a call or subscription
├── builds/            watching build.finished in process
└── deploys/           watching deploy.requested in process
```

## Where to look

| To see                                                  | Read                         |
| ------------------------------------------------------- | ---------------------------- |
| An event type beside the actions of its domain          | `src/builds/Builds.ts`       |
| A check source, its cursor the store's own              | `src/builds/events.ts`       |
| A cursor that tells a restart apart, as `truncated`     | `src/builds/store.ts`        |
| An action reporting progress as it runs                 | `src/builds/handlers.ts`     |
| An action answering a stream                            | `src/builds/log.ts`          |
| What a member may see, checked in the data access       | `src/builds/store.ts`        |
| A log source, and each subscriber's `match`             | `src/deploys/events.ts`      |
| Publishing to a log source from an action               | `src/deploys/handlers.ts`    |
| Waking a check source's subscribers after a write       | `src/builds/handlers.ts`     |
| Something set up upstream while a subscription lasts    | `src/deploys/events.ts`      |
| Watching events in process, with an action causing them | `test/builds/events.test.ts` |
