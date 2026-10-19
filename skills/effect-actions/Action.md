# Action

`Action.make` defines a contract: what an action takes and answers, whether it changes anything,
and who may call it. `Action.implement` binds contracts to handlers, behind an authorizer. Every
surface takes the implementation it returns, or a list of them, and `Action.client` calls one in
process.

A message the library throws says its fix; for a compiler diagnostic or Effect's own error, search
[Action-failures.md](Action-failures.md). For one symbol, `grep -rn <symbol> node_modules/@gjermundgaraba/effect-actions/dist/`:
each declaration's JSDoc carries its rules and gotchas, and this page only what an example
cannot show.

## Define a contract

One `Action.make` per action, in the domain's contract file. Export the domain's actions as one
`as const` list ([notes-service/src/notes/Notes.ts](node_modules/@gjermundgaraba/effect-actions/examples/notes-service/src/notes/Notes.ts)):
`implement` and every surface take lists.

```ts example=quickstart/src/greeting/Greeting.ts
import { Schema } from "effect";
import * as Action from "@gjermundgaraba/effect-actions/Action";

// A contract: what the action takes and answers, whether it changes anything, and who may
// call it. It imports no server code, so any client can import it, a browser page included.
export const Greet = Action.make("greet", {
  description: "Greet someone by name.",
  input: { name: Schema.String },
  success: Schema.String,
  readOnly: true,
  caller: Action.Anyone,
});
```

[notes-service/src/notes/Notes.ts](node_modules/@gjermundgaraba/effect-actions/examples/notes-service/src/notes/Notes.ts) adds declared
errors with their statuses, described fields and the list;
[kitchen-sink/src/issues/Issues.ts](node_modules/@gjermundgaraba/effect-actions/examples/kitchen-sink/src/issues/Issues.ts) uses every
option. The rules of each option, `input`'s optional fields and `error`'s tags included, are on
`Action.Options`; where an action must be listed to be served, and matching by object identity,
are on `Action.make`. The list each surface takes lives in one file beside the contracts
([kitchen-sink/src/Actions.ts](node_modules/@gjermundgaraba/effect-actions/examples/kitchen-sink/src/Actions.ts)).

- **List an action as a tool only where a model may hold what it takes and returns.** A tool
  call passes both through the model's context and records its arguments on the current span,
  a `Schema.Redacted` value included.

## Say who may call an action

`caller: Action.Anyone` makes a public action; an identity service, `caller: CurrentUser`, a
protected one, whose identity a remote surface gets by authenticating the request
([Authentication.md](Authentication.md#declare-how-callers-sign-in)) and a local surface, which
has no one to authenticate, from the host ([ActionToolkit.md](ActionToolkit.md#name-the-caller),
[ActionCli.md](ActionCli.md#name-the-caller), [ActionMcp.md](ActionMcp.md#serve-tools-over-stdio)).

`CurrentUser` is declared in
[notes-service/src/identity/Identity.ts](node_modules/@gjermundgaraba/effect-actions/examples/notes-service/src/identity/Identity.ts), and
a public action in [notes-service/src/status/Status.ts](node_modules/@gjermundgaraba/effect-actions/examples/notes-service/src/status/Status.ts).
The rules of an identity, never provided at startup, are on `Action.Options.caller`; a test
sends each caller's credential instead
([Testing.md](Testing.md#test-as-a-signed-in-caller)).

- **One protected contract serves callers with a token over HTTP and a local host without
  one**, never a public copy of it: the host provides the caller around `runStdio`
  ([notes-service/src/stdio.ts](node_modules/@gjermundgaraba/effect-actions/examples/notes-service/src/stdio.ts)); a second audience is
  `Operator` in [kitchen-sink/src/admin/Admin.ts](node_modules/@gjermundgaraba/effect-actions/examples/kitchen-sink/src/admin/Admin.ts).

## Implement actions

`Action.implement` binds a handler to one action, or a record of handlers keyed by name to a
list. Either may instead be a builder: an Effect, run once at startup, that returns the handler
or the record, whose services are startup services. What a handler yields per call, the caller
first, is a request-time requirement.

```ts example=notes-service/src/notes/handlers.ts
import { Effect } from "effect";
import * as Action from "@gjermundgaraba/effect-actions/Action";
import { authorize } from "../identity/authorize.js";
import { CurrentUser } from "../identity/Identity.js";
import { Notes } from "./Notes.js";
import { NoteStore } from "./store.js";

// The builder runs once, at startup, however many surfaces serve these actions: it is where a
// handler gets the services that last the process, never the caller. `CurrentUser` is read per
// call, inside each handler. Each handler is a thin step from the contract to the store, and
// none checks a scope: `authorize` has run before it.
export const notes = Action.implement(
  Notes,
  Effect.gen(function* () {
    const store = yield* NoteStore;

    return {
      listNotes: () =>
        Effect.gen(function* () {
          const user = yield* CurrentUser;
          const owned = yield* store.list(user.id);

          return { notes: owned.map(({ id, title }) => ({ id, title })) };
        }),
      getNote: ({ id }) => Effect.flatMap(CurrentUser, (user) => store.get(user.id, id)),
      createNote: ({ requestId, title, body }) =>
        Effect.flatMap(CurrentUser, (user) => store.create(user.id, title, body, requestId)),
      updateNote: ({ id, body, revision }) =>
        Effect.flatMap(CurrentUser, (user) => store.update(user.id, id, body, revision)),
      deleteNote: ({ id }) => Effect.flatMap(CurrentUser, (user) => store.remove(user.id, id)),
      importNotes: ({ notes }) =>
        Effect.map(
          Effect.flatMap(CurrentUser, (user) => store.createAll(user.id, notes)),
          (created) => ({ notes: created }),
        ),
    };
  }),
  { authorize },
);
```

A plain handler, no builder, is
[quickstart/src/greeting/handlers.ts](node_modules/@gjermundgaraba/effect-actions/examples/quickstart/src/greeting/handlers.ts). The
builder's rules, once per layer graph, a scope per call, passing the builder to `implement`
itself, calling through `Action.client` and never the function you passed, are on
`Action.implement`.

- **One implementation may hold public and protected actions**, and actions only some
  surfaces serve: group by domain.
- **Leave a handler's `Effect.fn` unnamed** unless you need handler-only timing. The span named
  after the action covers authorization, the handler and call cleanup, carrying `action.name`
  and `action.read_only` on it and its logs. Credential verification and input decoding run
  before it, so a request they reject has no action span; response encoding runs after it, so
  it can fail after a successful one.

## Authorize calls

An implementation holding a protected action states `{ authorize }`: a function of the called
action that succeeds, or fails with a refusal; no surface has a policy of its own. An
implementation of public actions alone takes none
([notes-service/src/status/handlers.ts](node_modules/@gjermundgaraba/effect-actions/examples/notes-service/src/status/handlers.ts)).

```ts example=notes-service/src/identity/authorize.ts
import { Effect } from "effect";
import * as Action from "@gjermundgaraba/effect-actions/Action";
import { CurrentUser, scopes } from "./Identity.js";

// The one rule, read from each contract: a read needs the read scope, anything else the write
// scope. Naming the missing scope lets an OAuth client ask for it and retry (`Forbidden`):
// `scopes` below goes with `protectedResource` in verifier.ts, copy both or neither.
// This named span measures authorization within the action's span, including a refusal.
export const authorize = Effect.fn("authorize")(function* (action: Action.Any) {
  const scope = action.readOnly ? scopes.read : scopes.write;
  const user = yield* CurrentUser;

  if (!user.scopes.includes(scope)) {
    return yield* new Action.Forbidden({ message: `Requires ${scope}.`, scopes: [scope] });
  }
});
```

Actions under another rule go in another `Action.implement` with its own `authorize`, or
`Action.allowAll`, not a branch on `action.name`. What a `Forbidden` with and without `scopes`
answers on each surface is on `Forbidden`.
Reading a store once, by an `authorize` that is an Effect returning the function, is
[assistant/src/identity/authorize.ts](node_modules/@gjermundgaraba/effect-actions/examples/assistant/src/identity/authorize.ts); that
rule, and that a limit is the handler's, are on `Action.implement`.

- **A caller the authorizer would refuse can still receive an `InvalidInput` describing the
  input's schema**, since input is decoded before the authorizer runs. To refuse or limit before
  decoding, use the layer's `middleware`
  ([ActionHttp.md](ActionHttp.md#split-a-binding-across-layers-and-add-middleware),
  [ActionRpc.md](ActionRpc.md#serve-the-rpcs)).
- **A limiter is a service the builder yields, apart from the store**
  ([kitchen-sink/src/issues/write-limit.ts](node_modules/@gjermundgaraba/effect-actions/examples/kitchen-sink/src/issues/write-limit.ts),
  [kitchen-sink/src/memory.ts](node_modules/@gjermundgaraba/effect-actions/examples/kitchen-sink/src/memory.ts)): state kept in a builder
  lasts only within one layer graph.
- **A check on one record belongs in the handler's data access**
  ([notes-service/src/notes/store.ts](node_modules/@gjermundgaraba/effect-actions/examples/notes-service/src/notes/store.ts)). So does a
  rule across callers, such as uniqueness.

## Fail with declared and built-in errors

A handler fails with the errors its action lists in `error`, and with the three built-in
errors, `InvalidInput`, `Unauthenticated` and `Forbidden`. What a refusal answers on each
surface is on `Action.Unauthenticated` and `Action.Forbidden`; what a declared error and bad
input answer, on each surface's `layer`, `layerHttp`, `runStdio`, `make` or `command`; when to
fail with `InvalidInput` yourself, on that class, as
[kitchen-sink/src/attachments/handlers.ts](node_modules/@gjermundgaraba/effect-actions/examples/kitchen-sink/src/attachments/handlers.ts)
does.

- **Map a client's `HttpClientError` and `SchemaError` to one declared error a caller can act
  on** ([mcp-tools/src/platform/print-farm.ts](node_modules/@gjermundgaraba/effect-actions/examples/mcp-tools/src/platform/print-farm.ts)).
  As defects, a model reads only a generic text.
- **Internal failures are never sent** over HTTP, MCP and RPC: what reaches the log and the
  call's `ErrorReporter`s is on `ActionHttp.layer`, `ActionMcp.layerHttp` and `ActionRpc.layer`;
  a Toolkit and a CLI make a defect the call's.

## Call actions in process

`Action.client(implementations)` gives the methods `ActionHttp.client` gives, for a job, an
agent or a test, without a transport. It is acquired where builders live:
[kitchen-sink/src/agent.ts](node_modules/@gjermundgaraba/effect-actions/examples/kitchen-sink/src/agent.ts) in a scoped program,
[notes-service/test/notes/notes.test.ts](node_modules/@gjermundgaraba/effect-actions/examples/notes-service/test/notes/notes.test.ts)
under `it.effect`. The rules are on `Action.client`; testing with it is
[Testing.md](Testing.md#test-an-implementation-in-process).

## Share one build across servers

Inside one `HttpRouter.serve` or one `Testing.layer`, a builder runs once, however many surfaces
serve it, a toolkit's `layer` provided to the routes included. Each `HttpRouter.serve` is a layer
graph of its own, the layers Effect builds together, each once, which shares nothing it builds
with another graph: a builder's run, a built authorizer, or an in-memory store of yours.

- **With one server, put everything the process runs inside the layer it serves**, a job or an
  agent beside the routes included; why a job merged beside `HttpRouter.serve` is not enough is
  on `Action.layer`.
- **Otherwise, provide `Action.layer(implementations)` and the services they share above the
  server and its siblings**: a second server, a program beside it, several `Testing.layer`s.
  [kitchen-sink/src/server.ts](node_modules/@gjermundgaraba/effect-actions/examples/kitchen-sink/src/server.ts) does it for two ports with
  the `builders` layer of [kitchen-sink/src/routes.ts](node_modules/@gjermundgaraba/effect-actions/examples/kitchen-sink/src/routes.ts),
  and [kitchen-sink/test/routes.test.ts](node_modules/@gjermundgaraba/effect-actions/examples/kitchen-sink/test/routes.test.ts) with two
  `Testing.layer`s, asserting one run of a builder both ports serve.
- **Inside one layer graph, a builder runs with the services of whichever surface builds it
  first**, and services provided around one surface reach the others: provide startup services
  once, for every surface. Where two must differ is on `Action.layer`.
