# ActionToolkit

Implementations as Effect's native AI `Toolkit`, for programs that call tools in-process
with `LanguageModel` or by hand. No server, no MCP envelope.

## API

Import `@gjermundgaraba/effect-actions/ActionToolkit`.

| API                               | Purpose                                                                                                         |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `make(implementations, options?)` | Project an implementation or a list; returns `{ toolkit, layer }`.                                              |
| `toolkit`                         | A native `Toolkit`: `toolkit.tools` holds the tool definitions by name, with typed schemas, hints and approval. |
| `layer`                           | The handler layer: acquires handlers in its scope; requires build-time services, not identity.                  |

| Option          | Meaning                                                                                                                          |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `needsApproval` | `(action) =>` a boolean, or a function of the call's input: the calls `LanguageModel` asks approval for instead of running them. |

Exported types: `Tools`, what `make` returns; `Options`, what it takes.

A local surface: each implementation's `before` hook runs before its handlers, and the caller
provides the identity.

Each tool takes and gives the JSON encoding of the action's schemas, as a model speaks and
as an MCP tool does, combines the action's errors with the built-in `InvalidInput`,
`Unauthenticated` and `Forbidden` in a native union, and uses `failureMode: "return"`. Its request requirements are its handler's plus its hook's, identity included; build
failures and services belong to the handler layer.

## Canonical

```ts
import { NodeRuntime } from "@effect/platform-node";
import { Console, Effect, Layer, Stream } from "effect";
import * as ActionToolkit from "@gjermundgaraba/effect-actions/ActionToolkit";
import { actors, CurrentActor } from "./authorization.js";
import { double, userActions } from "./handlers.js";
import { Users } from "./users.js";

// The implementations' hook runs for the in-process caller as for the servers.
const { toolkit, layer } = ActionToolkit.make([userActions, double]);

const program = Effect.gen(function* () {
  const tools = yield* toolkit;
  const calls = yield* tools.handle("getUser", { id: "1" }); // encoded arguments
  const results = yield* Stream.runCollect(calls);
  yield* Console.log(results);
}).pipe(
  Effect.provideService(CurrentActor, actors.alice), // identity around the whole invocation
  Effect.provide(layer.pipe(Layer.provide(Users.layerMemory))), // startup services only
);

program.pipe(NodeRuntime.runMain);
```

With a model: pass `toolkit` as `toolkit` to `LanguageModel.generateText` and provide `layer`.
Beside tools of your own, or provider-defined ones such as a web search, merge the toolkits
natively and provide every handler layer:

```ts
LanguageModel.generateText({ prompt, toolkit: Toolkit.merge(toolkit, WebKit) }).pipe(
  Effect.provide(Layer.mergeAll(layer, WebKitHandlers)),
);
```

To have the model's writes approved before they run:

```ts
const { toolkit, layer } = ActionToolkit.make([userActions, double], {
  needsApproval: (action) => action.access === "write",
});
```

A call of `renameUser` then ends the turn with a `tool-approval-request` part instead of a
result; the host answers it with a native `tool-approval-response` prompt part in the next turn.

## Rules

- Every action of the implementations passed becomes a tool, named after the action, with its `hints`. `make(implementations)` accepts one implementation or a list, such as `[userActions, double]`.
- A result's `result` is the action's decoded success or declared failure, and its `encodedResult` the JSON a model reads, such as `"42"` for a `BigInt`. There is no `{ value }` wrapper. Declared failures are returned as native tool results (`failureMode: "return"`), not raised.
- `tools.handle(name, encodedInput)` takes JSON arguments, as a model sends them: an ISO string for a `Schema.Date`, `null` for an absent `Schema.optional` field. It returns an Effect producing a result stream. The handler starts while that stream is constructed, so request services must be provided around the entire `handle(...).pipe(Effect.flatMap(Stream.runCollect))`, not only around the stream.
- Builders and identity follow the [dependency lifetimes](guarantees.md#dependency-lifetimes), and the hook the [authorization rules](guarantees.md#authorization): `layer` builds, and identity is supplied at invocation, never when building the layer.
- Each tool carries only its own handler's request requirements, plus the hook's, not those of sibling actions.
- `needsApproval` receives each action, typed as the implementations' own, once when `make` runs. It returns Effect's native `Tool.needsApproval` for its tool: a boolean, or a function of each call's decoded input and context returning a boolean or an `Effect` of one. Default: no tool needs approval.
- Each `make` call's handlers are its own: two toolkits with tools of one name, such as an implementation and an `Action.share` of it behind another hook, never run each other's handlers, whatever order their layers are provided in.
- `toolkit` is a native `Toolkit`: `Toolkit.merge` combines it with other tools, and `yield* toolkit` gives the handled toolkit once the handler layers of all its tools are provided.
- `LanguageModel` enforces approval; `tools.handle` ignores it, like any caller that is not a model's turn. It is not authorization, which stays the `before` hook's. MCP has no such field, so `ActionMcp` takes no such option.
- This is not an MCP server. Use `ActionMcp` to expose the same actions to external clients.
- Every tool declares the built-in errors ([guarantees.md](guarantees.md#wire-behavior)), so a `before` refusal, or a handler's built-in failure, is an ordinary returned tool failure.

## Failure modes

- Tool missing from the toolkit: its implementation was not passed to `make`.
- A defect when a tool handles a call: its own `layer` is not provided, only another `make` call's with tools of the same names, which the types accept. Provide the `layer` of the same `make` call.
- `Duplicate tool: <name>` thrown at `make`: two implementations serve actions of the same name.
- `Service not found` for a request tag at call time: it was provided only to the stream, or only to the layer. Provide it around the whole call effect.
- Type error on `layer` requirements: a build-time service is missing. Provide its Layer before `layer`.
- Result is `{ value: ... }` when a plain value was expected: you are reading an MCP response, not a Toolkit result. The Toolkit never wraps.
