# ActionToolkit

Implementations as Effect's native AI `Toolkit`, for programs that call tools in-process
with `LanguageModel` or by hand. No server, no MCP envelope.

## API

Import `@gjermundgaraba/effect-actions/ActionToolkit`.

| API                    | Purpose                                                                                        |
| ---------------------- | ---------------------------------------------------------------------------------------------- |
| `make(apps, options?)` | Project an implementation or a list; returns `{ toolkit, layer }`.                             |
| `toolkit`              | Native `Toolkit` with typed tool names, schemas and per-tool request requirements.             |
| `layer`                | The handler layer: acquires handlers in its scope; requires build-time services, not identity. |

| Option          | Meaning                                                                                                                          |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `needsApproval` | `(action) =>` a boolean, or a function of the call's input: the calls `LanguageModel` asks approval for instead of running them. |

Exported types: `Tools`, what `make` returns, and `Options`, what it takes.

A local surface: each implementation's `before` hook runs before its handlers, and the caller
provides the identity.

Each tool keeps the action's native input/success codecs, combines the action's errors with
the built-in `Unauthenticated` and `Forbidden` in a native union, and uses
`failureMode: "return"`. Its request requirements are its handler's plus its hook's, identity included; build
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
To have the model's writes approved before they run:

```ts
const { toolkit, layer } = ActionToolkit.make([userActions, double], {
  needsApproval: (action) => action.access === "write",
});
```

A call of `renameUser` then ends the turn with a `tool-approval-request` part instead of a
result; the host answers it with a native `tool-approval-response` prompt part in the next turn.

## Rules

- Every action of the implementations passed becomes a tool, named after the action, with its `hints`. `make(apps)` accepts one implementation or a list, such as `[userActions, double]`.
- Successes are the action's native values. There is no `{ value }` wrapper. Declared failures are returned as native tool results (`failureMode: "return"`), not raised.
- `tools.handle(name, encodedInput)` takes encoded arguments and returns an Effect producing a result stream. The handler starts while that stream is constructed, so request services must be provided around the entire `handle(...).pipe(Effect.flatMap(Stream.runCollect))`, not only around the stream.
- Builders, the hook and identity follow [guarantees.md](guarantees.md#dependency-lifetimes): `layer` builds, and identity is supplied at invocation, never when building the layer.
- Each tool carries only its own handler's request requirements, plus the hook's, not those of sibling actions.
- `needsApproval` receives each action, typed as the implementations' own, once when `make` runs. It returns Effect's native `Tool.needsApproval` for its tool: a boolean, or a function of each call's decoded input and context returning a boolean or an `Effect` of one. Default: no tool needs approval.
- `LanguageModel` enforces approval; `tools.handle` ignores it, like any caller that is not a model's turn. It is not authorization, which stays the `before` hook's. MCP has no such field, so `ActionMcp` takes no such option.
- This is not an MCP server. Use `ActionMcp` to expose the same actions to external clients.
- Every tool declares the refusals ([guarantees.md](guarantees.md#wire-behavior)), so a `before` refusal is an ordinary returned tool failure.

## Failure modes

- Tool missing from the toolkit: its implementation was not passed to `make`.
- `Duplicate tool: <name>` thrown at `make`: two implementations serve actions of the same name.
- `Service not found` for a request tag at call time: it was provided only to the stream, or only to the layer. Provide it around the whole call effect.
- Type error on `layer` requirements: a build-time service is missing. Provide its Layer before `layer`.
- Result is `{ value: ... }` when a plain value was expected: you are reading an MCP response, not a Toolkit result. The Toolkit never wraps.
