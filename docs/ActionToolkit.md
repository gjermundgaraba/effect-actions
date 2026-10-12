# ActionToolkit

Implementations as Effect's native AI `Toolkit`: one tool per action, run in the process that
calls the model, with no server. Reach for it when a `LanguageModel` or a `Chat` in your program
calls your actions. It is a local surface: nothing authenticates, and the host names the caller.
Code of your own calls the same implementations typed, with `Action.client`
([Action.md](Action.md#call-actions-in-process)).

## API

Import `@gjermundgaraba/effect-actions/ActionToolkit`.

| API                               | Purpose                                                                             |
| --------------------------------- | ----------------------------------------------------------------------------------- |
| `make(implementations, options?)` | Project an implementation or a list; returns `{ toolkit, layer }`.                  |
| `toolkit`                         | A native `Toolkit`, one tool per action, named after it.                            |
| `layer`                           | The tools' handlers, built once. Requires the startup services their builders read. |

| Option          | Meaning                                                                                                                                                |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `actions`       | The actions that are tools, among the implementations': `[GetUser, RenameUser]`. Defaults to every action of them.                                     |
| `needsApproval` | `(call, context) =>` a boolean, or an `Effect` of one: the calls a model must have approved ([Ask for approval](#ask-for-approval)). Defaults to none. |

Exported types: `Tools`, what `make` returns; `Options`, what it takes; `ToolCall<A>`, the call `needsApproval` receives, for a rule written apart from `make`.

## Give a model tools

Pass `toolkit` to `LanguageModel.generateText` or a `Chat`, and provide `layer`:
[assistant/src/toolkit.ts](../examples/assistant/src/toolkit.ts) and
[assistant/src/agent.ts](../examples/assistant/src/agent.ts).

```ts
export const { toolkit, layer } = ActionToolkit.make([tasks, identity]);

// One turn, as a member.
const turn = chat.generateText({ prompt, toolkit }).pipe(actingFor(member));

conversations.pipe(
  Effect.provide(model),
  // Once, around the program. Startup services only, never a caller.
  Effect.provide(layer.pipe(Layer.provide([TaskStore.layerFile, Permissions.layerMemory]))),
);
```

- Without `actions`, every action of the implementations is a tool, one added later included. Where a model must not get them all, list the tools ([Action.md](Action.md#define-a-contract)): [kitchen-sink/src/issues/assistant.ts](../examples/kitchen-sink/src/issues/assistant.ts).
- A refusal or a declared error is not raised. It is a tool result with `isFailure: true`, which the model reads and may act on.
- A turn's tool calls run concurrently unless `generateText` is given a `concurrency`. A service they share must tolerate it: [assistant/src/tasks/store.ts](../examples/assistant/src/tasks/store.ts) locks each change.
- Arguments the input does not declare are dropped, where HTTP and a CLI refuse them ([guarantees.md](guarantees.md#wire-behavior)): a misspelled optional argument is ignored silently.
- Beside other tools, merge natively and provide every handler layer: `Toolkit.merge(toolkit, others)` with `Layer.mergeAll(layer, othersHandlers)`.
- A model loop in a route: yield `toolkit` in the implementation's builder, `Action.implement(Ask, Effect.map(toolkit, (tools) => (input) => ...))`, and provide `layer` to the route's layer, `ActionHttp.layer(Http, ask).pipe(Layer.provide(layer))`. `Effect.provide(layer)` in the handler runs the tools' builders on every call, unless the routes also serve those implementations.

### Call a tool by hand

`yield* toolkit` gives `tools.handle(name, arguments)`, which takes the JSON a model sends, an
ISO string for a `Schema.Date`, and returns an Effect of a stream of results:
[assistant/test/toolkit.test.ts](../examples/assistant/test/toolkit.test.ts). The handler starts
when `handle` runs, so provide the caller around the whole
`handle(...).pipe(Effect.flatMap(Stream.runCollect))`, not around the stream alone. `handle`
never asks for approval.

## Name the caller

Provide the identity around each turn, or each call made by hand, as `actingFor` does in
[assistant/src/toolkit.ts](../examples/assistant/src/toolkit.ts): the approval rule, `authorize`
and the handlers of every call in the turn read it. The innermost one provided wins.

- Never provide an identity to `layer`, which is built once for every caller. It satisfies no protected tool's call, which still owes its own in its type, and it silently answers for any call that lacks one.
- A protected action's tool owes its identity whether or not its handler reads it ([Action.md](Action.md#say-who-may-call-an-action)).

## Ask for approval

`needsApproval` is one rule over every call a model makes, asked before the call runs. Every
write: `needsApproval: (call) => !call.action.readOnly`
([kitchen-sink/src/issues/assistant.ts](../examples/kitchen-sink/src/issues/assistant.ts)). A
rule reading the call's input and its caller:
[assistant/src/toolkit.ts](../examples/assistant/src/toolkit.ts).

- `call` is `{ name, action, input }`, the input decoded, over every action of the implementations, whatever `actions` lists. Check `call.name` to narrow the other two.
- The rule's `Effect` requires nothing: read the caller with `Effect.serviceOption`, and decide what the absence of one means.
- Its `Effect` cannot fail in its type, and one that fails anyway runs the call unapproved. To ask when a policy cannot be read, end it with `Effect.orElseSucceed(() => true)`.
- Approval is not authorization, which stays `authorize`. Only a model's turn asks for it, and `ActionMcp` has no such option.

A call that needs approval does not run: the turn ends with a `tool-approval-request` part in
`response.content` in place of its result. Start the next turn with the person's answers
([assistant/src/agent.ts](../examples/assistant/src/agent.ts)):

```ts
chat
  .generateText({
    toolkit,
    prompt: [
      {
        role: "tool",
        content: asked.content.flatMap((part) =>
          part.type === "tool-approval-request"
            ? [{ type: "tool-approval-response", approvalId: part.approvalId, approved: true }]
            : [],
        ),
      },
    ],
  })
  .pipe(actingFor(member));
```

- The answer needs the prompt history, where its request is found by `approvalId`. Sent alone through a bare `LanguageModel.generateText`, it runs nothing and raises nothing. Use a `Chat`, or send again the assistant message holding the call and its request, before the answer.
- An approved call runs in the answering turn, before the model is asked again, as whoever that turn runs as: provide the caller who was asked. `authorize` runs for it too ([assistant/test/toolkit.test.ts](../examples/assistant/test/toolkit.test.ts)).
- `approved: false` gives the model a failed result for the call, which does not run.

## Examples

| File                                                                                                 | Shows                                                                      |
| ---------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| [assistant/src/toolkit.ts](../examples/assistant/src/toolkit.ts)                                     | `make`; an approval rule reading the call and its caller; `actingFor`.     |
| [assistant/src/agent.ts](../examples/assistant/src/agent.ts)                                         | Turns through a `Chat`, an approval answered, where a real model plugs in. |
| [assistant/src/scripted.ts](../examples/assistant/src/scripted.ts)                                   | A scripted `LanguageModel`, standing where a provider's layer goes.        |
| [assistant/src/tasks/store.ts](../examples/assistant/src/tasks/store.ts)                             | A service that tolerates concurrent tool calls.                            |
| [assistant/test/toolkit.test.ts](../examples/assistant/test/toolkit.test.ts)                         | A call by hand, a refusal as a result, an approved call still authorized.  |
| [kitchen-sink/src/issues/assistant.ts](../examples/kitchen-sink/src/issues/assistant.ts)             | `actions`; `needsApproval` as a boolean of the action.                     |
| [kitchen-sink/src/agent.ts](../examples/kitchen-sink/src/agent.ts)                                   | `layer` with startup services; the caller around the turn.                 |
| [kitchen-sink/test/issues/assistant.test.ts](../examples/kitchen-sink/test/issues/assistant.test.ts) | The listed actions alone as tools; `tools.handle` behind `authorize`.      |

## Failure modes

- An approved call never runs, and nothing is raised: the `tool-approval-response` was sent without the history holding its request ([Ask for approval](#ask-for-approval)).
- `Type 'X' is not assignable to type 'never'` for a request service where a turn or a call by hand runs, or `Service not found` at call time from plain JavaScript: a protected tool owes its identity whatever its handler reads, or the service was provided to the stream alone. Provide it around the turn, or around the whole call effect.
- Type error on `layer`'s requirements: a build-time service is missing. Provide its Layer to `layer`.
- Type error on `needsApproval`'s `Effect`: it yields a service such as the caller. Read it with `Effect.serviceOption`.
- `Property '<field>' does not exist` on `call.input`: another action's input lacks the field. Check `call.name` first.
- A returned failure whose `result` is an `AiError` with reason `ToolParameterValidationError` (`failureOrigin: "parameters"`), not a declared error: the arguments did not decode. Neither `authorize` nor the handler ran.
- A turn fails with an `AiError`, `Failed to encode result for tool '<name>'`: the handler failed with an error its action does not declare, which a cast or plain JavaScript lets through. Declare it.
- A model reads base64 text where an image was meant: a tool's success holds an `Action.Image`, which a Toolkit gives the model as JSON text. Leave the action out of `actions`, or serve it over MCP, which sends an image block ([ActionMcp.md](ActionMcp.md#return-images-and-other-media)).
- `Listed in actions, but no implementation holds it: <names>` thrown at `make`: those actions are not among the implementations', by identity. `(another contract)` marks one whose name an implementation holds, as a second copy of the contracts module makes. Pass the implementation holding it, or list the contract it implements.
- `Duplicate tool: <name>` thrown at `make`: two implementations serve actions of one name. Rename one action; of two implementations of one contract, pass one.
- A defect when a tool handles a call: the `layer` provided is another implementation's, with tools of the same names, which the types accept. Provide a `layer` made from the implementations the `toolkit` was made from.
- Every toolkit of an implementation answers with one set of startup services: two layers of it, given different services, were provided together, and one serves them all. Use separate implementations for separate services.
- A job or an agent beside `HttpRouter.serve` reads other state than the routes, or its builder runs twice: its `layer` builds in another layer graph than the routes. Put it inside the layer the server serves, or provide `Action.layer` and the services they share above both ([Action.md](Action.md#share-one-build-across-servers)).
