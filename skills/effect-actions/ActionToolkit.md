# ActionToolkit

Implementations as Effect's native AI `Toolkit`: one tool per action, run in the process that
calls the model, with no server. Reach for it when a `LanguageModel` or a `Chat` in your program
calls your actions. Nothing authenticates: the host names the caller. Code of your own calls
the same implementations typed, with `Action.client`
([Action-in-process.md](Action-in-process.md#call-actions-in-process)).

New here? Start at [README.md](README.md).

## API

Import `@gjermundgaraba/effect-actions/ActionToolkit`.

| API                               | Purpose                                                                 |
| --------------------------------- | ----------------------------------------------------------------------- |
| `make(implementations, options?)` | Project an implementation or a list; returns `{ toolkit, layer }`.      |
| `toolkit`                         | A native `Toolkit`, one tool per action, named after it.                |
| `layer`                           | The tools' handlers. Requires the startup services their builders read. |

| Option          | Meaning                                                                                                        |
| --------------- | -------------------------------------------------------------------------------------------------------------- |
| `actions`       | The actions that are tools: `[GetUser, RenameUser]`. Defaults to every action of the implementations.          |
| `needsApproval` | `(call, context) =>` a boolean, or an `Effect` of one: the calls a model must have approved. Defaults to none. |

Exported types: `Tools`, what `make` returns; `Options`, what it takes; `ToolCall<A>`, the call `needsApproval` receives, for a rule written apart from `make`.

## Give a model tools

Pass `toolkit` to `LanguageModel.generateText` or a `Chat`, and provide `layer`:
[assistant/src/toolkit.ts](https://github.com/gjermundgaraba/effect-actions/blob/main/examples/assistant/src/toolkit.ts) and
[assistant/src/agent.ts](https://github.com/gjermundgaraba/effect-actions/blob/main/examples/assistant/src/agent.ts), with a scripted model in
[assistant/src/scripted.ts](https://github.com/gjermundgaraba/effect-actions/blob/main/examples/assistant/src/scripted.ts).

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

- Without `actions`, every action of the implementations is a tool, one added later included. Where a model must not get them all, list the tools ([Action.md](Action.md#define-a-contract)): [kitchen-sink/src/issues/assistant.ts](https://github.com/gjermundgaraba/effect-actions/blob/main/examples/kitchen-sink/src/issues/assistant.ts).
- A refusal or a declared error is not raised: it is a tool result with `isFailure: true`, which the model reads.
- A turn's tool calls run concurrently unless `generateText` is given a `concurrency`. A service they share must tolerate it: [assistant/src/tasks/store.ts](https://github.com/gjermundgaraba/effect-actions/blob/main/examples/assistant/src/tasks/store.ts) locks each change.
- Arguments the input does not declare are dropped, where HTTP and a CLI refuse them ([guarantees.md](guarantees.md#wire-behavior)): a misspelled optional argument is ignored silently.
- Beside other tools, merge natively and provide every handler layer: `Toolkit.merge(toolkit, others)` with `Layer.mergeAll(layer, othersHandlers)`.
- A model loop in a route: yield `toolkit` in the implementation's builder, `Action.implement(Ask, Effect.map(toolkit, (tools) => (input) => ...))`, and provide `layer` to the route's layer, `ActionHttp.layer(Http, ask).pipe(Layer.provide(layer))`. `Effect.provide(layer)` in the handler runs the tools' builders on every call, unless the routes also serve those implementations.

### Call a tool by hand

`yield* toolkit` gives `tools.handle(name, arguments)`, which takes the JSON a model sends, an
ISO string for a `Schema.Date`, and returns an Effect of a stream of results:
[assistant/test/toolkit.test.ts](https://github.com/gjermundgaraba/effect-actions/blob/main/examples/assistant/test/toolkit.test.ts). The handler starts
when `handle` runs, so provide the caller around the whole
`handle(...).pipe(Effect.flatMap(Stream.runCollect))`, not around the stream alone. `handle`
never asks for approval.

## Name the caller

Provide the identity around each turn, or each call made by hand, as `actingFor` does in
[assistant/src/toolkit.ts](https://github.com/gjermundgaraba/effect-actions/blob/main/examples/assistant/src/toolkit.ts): the approval rule, `authorize`
and the handlers of every call in the turn read it.

- Never provide an identity to `layer`, which is built once for every caller. It satisfies no protected tool's call, which still owes its own in its type, and it silently answers for any call that lacks one.
- A protected action's tool owes its identity whether or not its handler reads it ([Action.md](Action.md#say-who-may-call-an-action)).

## Ask for approval

`needsApproval` is one rule over every call a model makes, asked before the call runs. Every
write: `needsApproval: (call) => !call.action.readOnly`
([kitchen-sink/src/issues/assistant.ts](https://github.com/gjermundgaraba/effect-actions/blob/main/examples/kitchen-sink/src/issues/assistant.ts)). A
rule reading the call's input and its caller:
[assistant/src/toolkit.ts](https://github.com/gjermundgaraba/effect-actions/blob/main/examples/assistant/src/toolkit.ts).

- `call` is `{ name, action, input }`, the input decoded, over every action of the implementations, whatever `actions` lists. Check `call.name` to narrow the other two.
- The rule's `Effect` requires nothing: read the caller with `Effect.serviceOption`, and decide what the absence of one means.
- Its `Effect` cannot fail in its type, and one that fails anyway runs the call unapproved. To ask when a policy cannot be read, end it with `Effect.orElseSucceed(() => true)`.
- Approval is not authorization, which stays `authorize`. Only a model's turn asks for it, and `ActionMcp` has no such option.

A call that needs approval does not run: the turn ends with a `tool-approval-request` part in
`response.content` in place of its result. Start the next turn with the person's answers
([assistant/src/agent.ts](https://github.com/gjermundgaraba/effect-actions/blob/main/examples/assistant/src/agent.ts)):

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
- An approved call runs in the answering turn, before the model is asked again, as whoever that turn runs as: provide the caller who was asked. `authorize` runs for it too ([assistant/test/toolkit.test.ts](https://github.com/gjermundgaraba/effect-actions/blob/main/examples/assistant/test/toolkit.test.ts)).
- `approved: false` gives the model a failed result for the call, which does not run.
