# build-events

A CI service whose events are watched by its members: `build.finished`, read from a store that can be asked what finished since a cursor, and `deploy.requested`, published by the action that requests a deploy, with no store to ask. Each member sees only the pipelines they may. It serves both, with the actions that cause them, as an MCP endpoint, as HTTP routes and as Effect RPC, delivers them by webhook, keeping its subscriptions past a restart, and watches them in process, over each surface, and from a command line. A second service, the notifier, watches failed builds by webhook. Two actions answer more than one value: `startBuild` reports progress as it runs, and `tailLog` answers a stream of a build's log lines.

## Run it

From the repository root, after `vp install`:

```sh
node --import tsx examples/build-events/src/server.ts
BUILDS_TOKEN=grace node --import tsx examples/build-events/src/cli.ts watch build.finished
BUILDS_TOKEN=grace PUBLIC_URL=https://<a tunnel to port 3001> node --import tsx examples/build-events/src/notifier.ts
vp test examples/build-events
```

## Layout

```text
src/
├── identity/
│   ├── Identity.ts    contract: CurrentMember and the Login descriptor, with its principal and schema
│   ├── members.ts     the demo members
│   └── verifier.ts    Login's verifier: a token is a member's name
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
├── Api.ts             the HTTP binding: the actions' routes and the events' routes
├── Rpc.ts             the RPC binding: the actions' rpcs and the events' stream rpcs
├── routes.ts          the MCP endpoint, the HTTP routes and the rpcs, from one list of implementations, and webhook delivery
├── server.ts          entrypoint: the stores, the events announced, a body limit, webhook delivery's client, resolver and store, and Node's HTTP server
├── commands.ts        ActionCli.remote: a command per action, and `watch` per event type
├── cli.ts             entrypoint: the commands, calling the server over HTTP
├── notifier/
│   ├── Notices.ts     the failed builds the notifier was told of, and its Layer
│   └── routes.ts      the notifier: its receiver, and its watch by webhook reading from it
└── notifier.ts        entrypoint of the notifier, a second service
test/
├── support/           as: the caller of a call or subscription; inMemory: what the routes need, in memory
├── builds/            watching build.finished in process, a progress report and a log's stream
├── deploys/           watching deploy.requested in process
├── routes.test.ts     watching both over MCP, streamed and polled, in memory
├── http.test.ts       watching both over HTTP, as SSE and as JSON pages, in memory
├── rpc.test.ts        watching over Effect RPC, in memory
├── webhooks.test.ts   subscribing a callback, and the signed POSTs it receives, in memory
├── notifier.test.ts   the notifier told of failed builds by webhook, both services in memory
└── commands.test.ts   `watch build.finished` printing lines of JSON, in memory
```

## Where to look

| To see | Read |
| --- | --- |
| An event type beside the actions of its domain | `src/builds/Builds.ts` |
| A check source, its cursor the store's own | `src/builds/events.ts` |
| A cursor that tells a restart apart, as `truncated` | `src/builds/store.ts` |
| An action reporting progress as it runs | `src/builds/handlers.ts` |
| An action answering a stream | `src/builds/log.ts` |
| What a member may see, checked in the data access | `src/builds/store.ts` |
| A log source, and each subscriber's `match` | `src/deploys/events.ts` |
| Publishing to a log source from an action | `src/deploys/handlers.ts` |
| Waking a check source's subscribers after a write | `src/builds/handlers.ts` |
| Something set up upstream while a subscription lasts | `src/deploys/events.ts` |
| Watching events in process, with an action causing them | `test/builds/events.test.ts` |
| Serving events over MCP, and what it needs of `Login` | `src/routes.ts` |
| Watching over MCP, by stream and by poll | `test/routes.test.ts` |
| Binding events to HTTP routes beside the actions | `src/Api.ts` |
| Watching over HTTP, by SSE and by JSON pages | `test/http.test.ts` |
| Serving events as stream rpcs, and their serialization | `src/routes.ts` |
| Watching over RPC | `test/rpc.test.ts` |
| Watching from a command line, as lines of JSON | `src/commands.ts` |
| Delivering events by webhook, and what it needs | `src/routes.ts`, `src/server.ts` |
| Keeping webhook subscriptions past a restart | `src/server.ts`, `src/identity/Identity.ts` |
| Subscribing a callback, and checking each signature | `test/webhooks.test.ts` |
| Watching by webhook from a second service | `src/notifier/routes.ts` |
| Two services in memory, each calling the other | `test/notifier.test.ts` |
