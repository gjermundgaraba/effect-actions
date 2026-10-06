# ActionToolkit

Implementations as Effect's native AI `Toolkit`, for programs that call tools in-process
with `LanguageModel` or by hand. No server. A tool takes and gives JSON, as a model does; code
of your own calls the implementations typed, with `Action.client` ([Action.md](Action.md#clients)).

## API

Import `@gjermundgaraba/effect-actions/ActionToolkit`.

| API                               | Purpose                                                                                                             |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `make(implementations, options?)` | Project an implementation or a list; returns `{ toolkit, layer }`.                                                  |
| `toolkit`                         | A native `Toolkit`: `toolkit.tools` holds the tool definitions by name, with typed schemas, MCP hints and approval. |
| `layer`                           | The handler layer: builds handlers and built authorizers in its scope; requires build-time services and checks.     |

| Option          | Meaning                                                                                                                                    |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `actions`       | The actions that are tools, among the implementations': `[GetUser, RenameUser]`. Defaults to every action of them.                         |
| `needsApproval` | `(call) =>` a boolean, or an `Effect` of one: the calls `LanguageModel` asks approval for instead of running them ([Approval](#approval)). |

Exported types: `Tools`, what `make` returns; `Options`, what it takes.

A local surface: each implementation's `authorize` runs before the handlers of its protected
actions, the actions' checks after it, and the caller provides the identity.

Each tool takes and gives the JSON encoding of the action's schemas, as a model speaks and
as an MCP tool does, combines the action's errors with the built-in `InvalidInput`,
`Unauthenticated` and `Forbidden` in a native union, and uses `failureMode: "return"`. Its request requirements are its handler's, its authorizer's and its checks', and a protected
action's identity, whether or not anything reads it; build failures and services, the checks'
layers included, belong to the handler layer.

## Canonical

```ts example=toolkit-authorized.ts
import { NodeRuntime } from "@effect/platform-node";
import { Console, Effect, Layer, Stream } from "effect";
import * as ActionToolkit from "@gjermundgaraba/effect-actions/ActionToolkit";
import { actors, CurrentActor } from "./authorization.js";
import { double, userActions } from "./handlers.js";
import { Users } from "./users.js";

// The implementations' `authorize` runs for the in-process caller as for the servers.
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

### Approval

```ts example=toolkit-approval.ts
import { Effect, Option } from "effect";
import { LanguageModel } from "effect/ai";
import * as ActionToolkit from "@gjermundgaraba/effect-actions/ActionToolkit";
import { type Actor, CurrentActor } from "./authorization.js";
import { double, userActions } from "./handlers.js";

// A model's writes wait for their caller's approval, except a rename of the caller itself:
// `call.name` narrows `call.input` across both implementations. Without a caller, it asks.
export const { toolkit, layer } = ActionToolkit.make([userActions, double], {
  needsApproval: (call) =>
    !call.action.readOnly &&
    Effect.map(
      Effect.serviceOption(CurrentActor),
      Option.match({
        onNone: () => true,
        onSome: ({ id }) => call.name !== "renameUser" || call.input.id !== id,
      }),
    ),
});

// One turn: the caller is provided around it, for the approval, `authorize` and the handlers.
export const chat = (actor: Actor, prompt: string) =>
  LanguageModel.generateText({ prompt, toolkit }).pipe(Effect.provideService(CurrentActor, actor));
```

A call that needs approval ends the turn with a `tool-approval-request` part instead of a
result; the host answers it with a native `tool-approval-response` prompt part in the next turn.
Every write, whoever calls: `needsApproval: (call) => !call.action.readOnly`. A
toolkit made for another agent or policy from the same implementations runs with this `layer`:
provide it once. So does one of fewer tools, such as an agent's
`ActionToolkit.make(userActions, { actions: [GetUser] }).toolkit`.

## Rules

- Every action of the implementations passed becomes a tool, named after the action, with its `mcp` hints, unless `actions` lists the tools: then only those, each behind its implementation's authorizer and from its builder's one run, and an implementation holding none of them is not built. `make(implementations)` accepts one implementation or a list, such as `[userActions, double]`. The types take only actions of the implementations, and type `toolkit` and `layer`'s build services by the listed actions alone; `needsApproval`'s `call` is typed by every action of the implementations. Options whose `actions` may be absent, such as a value typed `ActionToolkit.Options<A>`, serve every action when it is absent and the listed ones when given, so their types owe what every action owes, and hold only the tools present either way ([guarantees.md](guarantees.md#names)).
- A result's `result` is the action's decoded success or declared failure, and its `encodedResult` the JSON a model reads, such as `"42"` for a `BigInt`. Declared failures are returned as native tool results (`failureMode: "return"`), not raised.
- `tools.handle(name, encodedInput)` takes JSON arguments, as a model sends them: an ISO string for a `Schema.Date`, `null` for an absent `Schema.optional` field. It returns an Effect producing a result stream. The handler starts while that stream is constructed, so request services must be provided around the entire `handle(...).pipe(Effect.flatMap(Stream.runCollect))`, not only around the stream.
- Builders, calls and identity follow the [dependency lifetimes](guarantees.md#dependency-lifetimes), and authorization and checks the [authorization rules](guarantees.md#authorization): `layer` builds, a call releases what it acquired when it ends, whether a model's turn or `tools.handle` makes it, and identity is supplied at invocation, never when building the layer. A protected tool's call owes its identity in its type; one call without it anyway, as from plain JavaScript, fails with `Unauthenticated` before `authorize` runs. The innermost caller provided wins: a call made under a narrower identity runs as that one.
- A model loop in a route yields `toolkit` in its implementation's builder, `Action.implement(Chat, Effect.map(toolkit, (tools) => ({ prompt }) => ...), { authorize })`, and passes `tools` to `LanguageModel.generateText`; the route's layer takes the toolkit's `layer`, `ActionHttp.layer(ChatHttp, chat).pipe(Layer.provide(layer))`. That is one build, in the routes' layer graph, shared with every surface serving the same implementations. `Effect.provide(layer)` in the handler builds it for every call unless a surface of the graph serves the same implementations, and `HttpRouter.provideRequest(layer)` once, but in a layer graph of its own: a second build when another surface serves them, as `Layer.mergeAll`'s order decides.
- Each tool carries only its own handler's request requirements, plus its authorizer's and its checks', not those of sibling actions.
- `needsApproval` is one function over every call a model makes, before the call runs: `(call, context) =>`, where `call` is `{ name, action, input }`, the input decoded, and `context` is Effect's native approval context. `call` is typed by every action of the implementations, whatever `actions` lists, and checking `call.name` narrows `call.action` and `call.input` to that action's, across implementations too: `(call) => call.name === "erase" && call.input.id !== "draft"`. It gives a boolean, or an `Effect` of one that requires nothing: it runs in the caller's context, so it reads the caller with `Effect.serviceOption`. Default: no tool needs approval.
- A `needsApproval` Effect that fails means no approval is needed, as `LanguageModel` decides natively. Its `Effect` cannot fail in its type: decide in `needsApproval` what a failure means, `Effect.orElseSucceed(() => true)` to ask when a policy cannot be read.
- Tools belong to what runs them, their implementation's handlers behind its authorizer: the `layer` of a `make` call serves the tools it selected in any `toolkit` of the same implementations, a toolkit of fewer `actions` included, so toolkits made per agent or per approval policy run with one handler layer, built once. Two implementations never run each other's handlers, even with tools of one name, such as two implementations of one action behind different authorizers, whatever order their layers are provided in.
- `toolkit` is a native `Toolkit`: `Toolkit.merge` combines it with other tools, and `yield* toolkit` gives the handled toolkit once the handler layers of all its tools are provided.
- `LanguageModel` enforces approval; `tools.handle` ignores it, like any caller that is not a model's turn. It is not authorization, which stays the implementation's `authorize`. MCP has no such field, so `ActionMcp` takes no such option.
- This is not an MCP server. Use `ActionMcp` to expose the same actions to external clients.
- Every tool declares the built-in errors ([guarantees.md](guarantees.md#wire-behavior)), so an authorizer's refusal, or a handler's built-in failure, is an ordinary returned tool failure, as is a check's declared error.

## Failure modes

- Tool missing from the toolkit: its implementation was not passed to `make`, or `actions` leaves it out.
- `Listed in actions, but no implementation holds it: <names>` thrown at `make`: those actions are not among the implementations' actions, by identity. `(another contract)` marks one whose name an implementation holds, as a second copy of the contracts module makes. Pass the implementation holding it, or list the contract it implements.
- A defect when a tool handles a call: no `layer` of its implementation is provided, only one of another implementation with tools of the same names, such as another implementation of the same actions, which the types accept. Provide a `layer` made from the implementations the `toolkit` was made from.
- A job or an agent beside `HttpRouter.serve`, or a model loop in a route given `layer` with `HttpRouter.provideRequest`, reads other state than the routes, or its builder runs twice: its `layer` builds in another layer graph than the routes. Put it inside the layer the server serves, a route's toolkit in its builder ([Rules](#rules)), or provide `Action.layer` and the services they share above both ([dependency lifetimes](guarantees.md#dependency-lifetimes)).
- Every toolkit of an implementation answering with one set of startup services: two layers of it, built apart with different services, were provided together, and one of them serves its tools. Use separate implementations for separate services.
- Type error on `needsApproval`'s `Effect`, which requires a service such as the caller: `needsApproval` requires nothing. Read the caller with `Effect.serviceOption(CurrentActor)`, which gives `Option.none()` without one.
- `Property '<field>' does not exist` on `call.input`: `call` is a union over every action of the toolkit, and another action's input lacks the field. Check `call.name` first.
- `Duplicate tool: <name>` thrown at `make`: two implementations serve actions of the same name. Rename one action. `actions` tells apart only separate contracts sharing a name, listing one; two implementations of the same contract stay both listed: pass one implementation.
- `Service not found` for a request tag at call time: it was provided only to the stream. Provide it around the whole call effect. Providing a service to `layer` does not fail: that startup value fills in for every call that lacks its own ([guarantees.md](guarantees.md#dependency-lifetimes)), so never provide an identity there; a protected tool's call still owes it in its type.
- `Type 'CurrentActor' is not assignable to type 'never'` where a program calling a tool runs: the tool's action is protected, and its call owes the caller, whatever the handler reads. Provide it around the call, or around the turn.
- A returned failure whose `result` is an `AiError` with reason `ToolParameterValidationError` (`failureOrigin: "parameters"`), not a declared error: the arguments did not decode. Authorization, the checks and the handler did not run.
- Type error on `layer` requirements: a build-time service is missing, or a check's layer, such as `Limited`. Provide its Layer before `layer`.
