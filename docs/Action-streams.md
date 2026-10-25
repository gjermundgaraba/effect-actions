# Progress and streamed answers

An action answers once, at the end. Two options let a caller see more while it runs: `progress`,
values the handler reports along the way, which a caller may miss some of, and `Action.Stream`,
an answer of many elements, each arriving as it is produced. Both are declared on the contract
([Action.md](Action.md#define-a-contract)) and carried by every surface its own way: the
declaration's JSDoc says how.

A message the library throws says its fix; for a compiler diagnostic or Effect's own error,
search [Action-failures.md](Action-failures.md). For one symbol,
`grep -rn <symbol> node_modules/@gjermundgaraba/effect-actions/dist/`.

## Report progress

An action declaring `progress`, a schema or struct fields, gets a second argument in its
handler, `{ progress }`, which reports a value to the caller without waiting for it; a client's
call takes `{ onProgress }` after its input
([kitchen-sink/test/issues/export.test.ts](../examples/kitchen-sink/test/issues/export.test.ts)).
The contract is `ExportIssues` in
[kitchen-sink/src/issues/Issues.ts](../examples/kitchen-sink/src/issues/Issues.ts), which also
answers a stream; its handler is below.

The rules are on `Action.Options.progress`; how each surface carries the values, on
`ActionHttp.layer`, `ActionRpc.make`, `ActionMcp.layerHttp`, `ActionToolkit.make` and
`ActionCli.command`.

- **Report a snapshot to show, never an event to count.** A caller falling behind loses the
  oldest values, never the answer: what a caller must receive each time is the answer.

## Answer a stream

An action whose `success` is `Action.Stream(element)` has a handler returning a `Stream` of
elements, and every client's call returns one
([kitchen-sink/test/issues/export.test.ts](../examples/kitchen-sink/test/issues/export.test.ts)).

```ts example=kitchen-sink/src/issues/export.ts
import { Effect, Stream } from "effect";
import * as Action from "@gjermundgaraba/effect-actions/Action";
import { authorize } from "../identity/authorize.js";
import { ExportIssues } from "./Issues.js";
import { IssueStore } from "./store.js";
import { exportLimit } from "./write-limit.js";

export const exports = Action.implement(
  ExportIssues,
  Effect.gen(function* () {
    const store = yield* IssueStore;
    const limited = yield* exportLimit;

    // The handler returns a `Stream`. The limit is spent before the first issue, so a refused
    // export fails as an action answering one value does, a 429 over HTTP; a failure after an
    // issue would end the stream instead, the issues before it already sent.
    return ({ status }, { progress }) =>
      Stream.unwrap(
        limited((member) =>
          Effect.map(store.count(member.workspace, status), (total) =>
            store.all(member.workspace, status).pipe(
              Stream.zipWithIndex,
              // `progress` never waits for the caller, dropping the oldest values a slow one has not taken:
              // `exported` may skip numbers, so it says how far the export is, not what arrived.
              Stream.mapEffect(([issue, index]) =>
                Effect.as(progress({ exported: index + 1, total }), issue),
              ),
            ),
          ),
        ),
      );
  }),
  { authorize },
);
```

How each surface carries it is on `ActionHttp.layer`, `ActionRpc.make` and `ActionCli.command`.

- **MCP and a toolkit leave it out.** A tool answers one result, so an endpoint and a toolkit
  given implementations whole serve every other action, as
  [kitchen-sink/src/routes.ts](../examples/kitchen-sink/src/routes.ts) serves `exports`, and
  refuse one their `actions` list names; `ActionMcp.client` gives such an action no method.
