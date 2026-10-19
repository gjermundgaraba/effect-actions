# Action

`Action.make` defines a contract: what an action takes and answers, whether it changes anything,
and who may call it. `Action.implement` binds contracts to handlers, behind an authorizer. Every
surface takes the implementation it returns, or a list of them, and `Action.client` calls one in
process.

Read this page alone, in one tool call; if its output says it was truncated, read it again alone.
A message the library throws says its fix; for a compiler diagnostic or Effect's own error, search
[Action-failures.md](Action-failures.md). Reading order: [SKILL.md](SKILL.md). For one symbol, `grep -rn <symbol> node_modules/@gjermundgaraba/effect-actions/dist/`:
each declaration's JSDoc carries its rules and gotchas, and this page only what an example
cannot show.

## Define a contract

One `Action.make` per action, in the domain's contract file, which imports no server code, so a
browser or a CLI can import it. Export the domain's actions as one `as const` list: `implement`
and every surface take lists.

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
`Action.Options`. A contract says nothing about where it is served: each surface takes a list,
kept in one file beside the contracts
([kitchen-sink/src/Actions.ts](node_modules/@gjermundgaraba/effect-actions/examples/kitchen-sink/src/Actions.ts)); that, and matching by
object identity, are on `make`.

- **List an action as a tool only where a model may hold what it takes and returns.** A tool
  call passes both through the model's context and records its arguments on the current span,
  a `Schema.Redacted` value included.

## Say who may call an action

`caller: Action.Anyone` makes a public action. An identity service, `caller: CurrentUser`, makes
a protected one: every surface requires that identity, whether or not the handler reads it. A
remote surface gets it by authenticating the request
([Authentication.md](Authentication.md#declare-how-callers-sign-in)); a local surface has no one
to authenticate, so the host provides it ([ActionToolkit.md](ActionToolkit.md#name-the-caller),
[ActionCli.md](ActionCli.md#name-the-caller), [ActionMcp.md](ActionMcp.md#serve-tools-over-stdio)).

`CurrentUser` is declared in
[notes-service/src/identity/Identity.ts](node_modules/@gjermundgaraba/effect-actions/examples/notes-service/src/identity/Identity.ts),
apart from its verifier, and a public action in
[notes-service/src/status/Status.ts](node_modules/@gjermundgaraba/effect-actions/examples/notes-service/src/status/Status.ts).

The rules of an identity, never provided at startup, one per action, are on `caller`; a test
sends each caller's credential instead ([Testing.md](Testing.md#test-as-a-signed-in-caller)).

- **One protected contract serves callers with a token over HTTP and a local host without
  one**, never a public copy of it: the host provides the caller around `runStdio`
  ([notes-service/src/stdio.ts](node_modules/@gjermundgaraba/effect-actions/examples/notes-service/src/stdio.ts)). A second audience
  takes its own identity, descriptor and binding (`Operator` in
  [kitchen-sink/src/admin/Admin.ts](node_modules/@gjermundgaraba/effect-actions/examples/kitchen-sink/src/admin/Admin.ts)).

## Implement actions

`Action.implement` binds a handler to one action, or a record of handlers keyed by name to a
list. Either may instead be a builder: an Effect, run once at startup, that returns the handler
or the record. It is how a handler gets a startup service; what differs per call, the caller
first, the handler reads itself.

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
itself, calling through `client` and never the function you passed, are on `implement`.

- **One implementation may hold public and protected actions**, and actions only some
  surfaces serve: group by domain.
- **Leave a handler's `Effect.fn` unnamed** unless you need handler-only timing. The span named
  after the action covers authorization, the handler and call cleanup, carrying `action.name`
  and `action.read_only` on it and its logs. Credential verification and input decoding run
  before it, so a request they reject has no action span; response encoding runs after it, so
  it can fail after a successful one. The named authorizer below measures authorization as a
  child of it.

## Authorize calls

An implementation holding a protected action states `{ authorize }`: a function of the called
action that succeeds, or fails with a refusal. Every surface runs it before the handler, and
none has a policy of its own. An implementation of public actions alone takes none
([notes-service/src/status/handlers.ts](node_modules/@gjermundgaraba/effect-actions/examples/notes-service/src/status/handlers.ts)), and
the authorizer never runs for a public action.

```ts example=notes-service/src/identity/authorize.ts
import { Effect } from "effect";
import * as Action from "@gjermundgaraba/effect-actions/Action";
import { CurrentUser, scopes } from "./Identity.js";

// The one rule, read from each contract: a read needs the read scope, anything else the write
// scope. Every implementation of protected actions states it, so HTTP, MCP and stdio all run it
// before the handler. Naming the missing scope lets an OAuth client ask for it and retry: it is
// answered a challenge, which only a server publishing discovery (verifier.ts) can follow up.
// Where tokens are fixed, such as API keys, name no scope: the refusal is then a plain one.
// So `scopes` below goes when `protectedResource` in verifier.ts does: copy both or neither.
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
`Action.allowAll`, not a branch on `action.name`. With fixed tokens, leave `scopes` out, as the
comment says: what a `Forbidden` with and without them answers on each surface is on `Forbidden`.
Reading a store once, by an `authorize` that is an Effect returning the function, is
[assistant/src/identity/authorize.ts](node_modules/@gjermundgaraba/effect-actions/examples/assistant/src/identity/authorize.ts); that
rule, and that a limit is the handler's, are on `implement`.

- **A call runs authentication, then over HTTP and RPC the layer's `middleware`, input
  decoding, the authorizer, then the handler**, each refusing before the next. So a caller the
  authorizer would refuse can still receive an `InvalidInput` describing the input's schema. To
  refuse or limit before decoding, use that `middleware`
  ([ActionHttp.md](ActionHttp.md#serve-the-routes), [ActionRpc.md](ActionRpc.md#serve-the-rpcs)).
- **A limiter is a service the builder yields, apart from the store**
  ([kitchen-sink/src/issues/write-limit.ts](node_modules/@gjermundgaraba/effect-actions/examples/kitchen-sink/src/issues/write-limit.ts)):
  a service is shared wherever it is provided
  ([kitchen-sink/src/memory.ts](node_modules/@gjermundgaraba/effect-actions/examples/kitchen-sink/src/memory.ts)), state kept in a
  builder only within one layer graph.
- **A check on one record belongs in the handler's data access**
  ([notes-service/src/notes/store.ts](node_modules/@gjermundgaraba/effect-actions/examples/notes-service/src/notes/store.ts)). So does a
  rule across callers, such as uniqueness.

## Fail with declared and built-in errors

A handler fails with the errors its action lists in `error`, and with the three built-in
errors, `InvalidInput`, `Unauthenticated` and `Forbidden`, which every surface declares and
every client decodes as typed values. No other failure compiles, and a failure the schemas
reject is the call's defect. What each answers on each surface, when to fail with
`InvalidInput` yourself, and that another service's refusal is mapped before it is passed on,
are on each class; [kitchen-sink/src/attachments/handlers.ts](node_modules/@gjermundgaraba/effect-actions/examples/kitchen-sink/src/attachments/handlers.ts)
fails with `InvalidInput` for input that decodes but cannot be served.

- **Map a client's `HttpClientError` and `SchemaError` to one declared error a caller can act
  on** ([mcp-tools/src/platform/print-farm.ts](node_modules/@gjermundgaraba/effect-actions/examples/mcp-tools/src/platform/print-farm.ts)).
  As defects, a model reads only a generic text.
- **Internal failures are never sent.** Over HTTP, MCP and RPC, the cause of a defect goes to
  the log and to the call's `ErrorReporter`s: those the server runs with, provided around
  `HttpRouter.serve` or `Testing.layer`, win over those provided to one surface's layer, which
  only fill in what a request lacks.

## Call actions in process

`Action.client(implementations)` gives the methods `ActionHttp.client` gives, for a job, an
agent or a test. A call runs what a remote call runs, the codecs, the authorizer and the
handler, without a transport, and owes per call what they read, the caller first. Acquiring it
builds the implementations, so it needs a `Scope` and their startup services, and happens once,
where builders live: [kitchen-sink/src/agent.ts](node_modules/@gjermundgaraba/effect-actions/examples/kitchen-sink/src/agent.ts) in a
scoped program,
[notes-service/test/notes/notes.test.ts](node_modules/@gjermundgaraba/effect-actions/examples/notes-service/test/notes/notes.test.ts)
under `it.effect`, which supplies the scope. The rules are on `client`; testing with it is
[Testing.md](Testing.md#test-an-implementation-in-process).

## Share one build across servers

Inside one `HttpRouter.serve` or one `Testing.layer`, a builder runs once, however many surfaces
serve it, a toolkit's `layer` provided to the routes included. But each `HttpRouter.serve` builds
its routes in a layer graph of its own, which reuses what is provided from outside it and shares
nothing it builds itself: a builder's run, a built authorizer, or a service of yours such as an
in-memory store.

- **With one server, put everything the process runs inside the layer it serves**, a job or an
  agent beside the routes included; why a job merged beside `HttpRouter.serve` is not enough is
  on `layer`.
- **Otherwise, provide `Action.layer(implementations)` and the services they share above the
  server and its siblings**: a second server, a program beside it, several `Testing.layer`s.
  [kitchen-sink/src/server.ts](node_modules/@gjermundgaraba/effect-actions/examples/kitchen-sink/src/server.ts) does it for two ports with
  the `builders` layer of [kitchen-sink/src/routes.ts](node_modules/@gjermundgaraba/effect-actions/examples/kitchen-sink/src/routes.ts),
  and [kitchen-sink/test/routes.test.ts](node_modules/@gjermundgaraba/effect-actions/examples/kitchen-sink/test/routes.test.ts) with two
  `Testing.layer`s, asserting one run of a builder both ports serve.
- **Inside one layer graph, a builder runs with the services of whichever surface builds it
  first**, and services provided around one surface reach the others: provide startup services
  once, for every surface. Where two surfaces must differ, wrap each in `Layer.fresh`, providing
  what they share, authentication included, outside it.
