# ActionToolkit

Implementations as Effect's native AI `Toolkit`: one tool per action, run in the process that
calls the model, with no server. Reach for it when a `LanguageModel` or a `Chat` in your program
calls your actions. Nothing authenticates: the host names the caller. Code of your own calls
the same implementations typed, with `Action.client`
([Action-in-process.md](Action-in-process.md#call-actions-in-process)).

Read this page alone, in one tool call; if its output says it was truncated, read it again alone.
When something fails, search [ActionToolkit-failures.md](ActionToolkit-failures.md). Reading order:
[SKILL.md](SKILL.md).

## API

Import `@gjermundgaraba/effect-actions/ActionToolkit`.

| API                               | Purpose                                                                        |
| --------------------------------- | ------------------------------------------------------------------------------ |
| `make(implementations, options?)` | Project an implementation or a list; returns `{ toolkit, layer }`.             |
| `toolkit`                         | A native `Toolkit`, one tool per action, named after it.                       |
| `layer`                           | The tools' handlers. Requires the startup services their builders read.        |
| `openApprovals(history)`          | The approval requests a `Chat`'s history still holds open, each with its call. |

| Option          | Meaning                                                                                                        |
| --------------- | -------------------------------------------------------------------------------------------------------------- |
| `actions`       | The actions that are tools: `[GetUser, RenameUser]`. Defaults to every action of the implementations.          |
| `needsApproval` | `(call, context) =>` a boolean, or an `Effect` of one: the calls a model must have approved. Defaults to none. |

Exported types: `Tools`, what `make` returns; `Options`, what it takes; `ToolCall<A>`, the call `needsApproval` receives, for a rule written apart from `make`; `Approval`, what `openApprovals` lists.

## Give a model tools

Pass `toolkit` to `LanguageModel.generateText` or a `Chat`, and provide `layer`:
[assistant/src/toolkit.ts](node_modules/@gjermundgaraba/effect-actions/examples/assistant/src/toolkit.ts) and
[assistant/src/agent.ts](node_modules/@gjermundgaraba/effect-actions/examples/assistant/src/agent.ts), with a scripted model in
[assistant/src/scripted.ts](node_modules/@gjermundgaraba/effect-actions/examples/assistant/src/scripted.ts).

```ts
export const { toolkit, layer } = ActionToolkit.make([tasks, identity]);

// One turn, as a member.
const turn = chat.generateText({ prompt, toolkit }).pipe(actingFor(member));

conversations.pipe(
  Effect.provide(model),
  // Once, around the program. Startup services only, never a caller.
  Effect.provide(layer.pipe(Layer.provide([tasksFile, Permissions.layerMemory]))),
);
```

- **One `generateText` is one request to the model.** Its tool calls run, and their results come back in the response, unread by the model. For the model to read them, ask the `Chat` again with `prompt: []` while a response has `toolCalls` and no `tool-approval-request`.
- Without `actions`, every action of the implementations is a tool, one added later included. Where a model must not get them all, list the tools ([Action.md](Action.md#define-a-contract)): [kitchen-sink/src/issues/assistant.ts](node_modules/@gjermundgaraba/effect-actions/examples/kitchen-sink/src/issues/assistant.ts).
- A refusal or a declared error is not raised: it is a tool result with `isFailure: true`, which the model reads. So are arguments that do not decode, an `AiError` (`ToolParameterValidationError`), not `InvalidInput`: neither `authorize` nor the handler ran.
- A turn's tool calls, the approved calls of an answering turn included, run concurrently unless `generateText` is given a `concurrency`. A service they share must tolerate it: [assistant/src/tasks/store.ts](node_modules/@gjermundgaraba/effect-actions/examples/assistant/src/tasks/store.ts) locks each change.
- Arguments the input does not declare are dropped, where HTTP and a CLI refuse them ([guarantees.md](guarantees.md#wire-behavior)): a misspelled optional argument is ignored silently.
- Beside other tools, merge natively and provide every handler layer: `Toolkit.merge(toolkit, others)` with `Layer.mergeAll(layer, othersHandlers)`.
- **A model loop behind a route.** Yield `toolkit` and the model in the implementation's builder, `Action.implement(Ask, Effect.map(toolkit, (tools) => (input) => ...))`: what the handler itself yields is owed per request. Provide `layer` to the route's layer, `ActionHttp.layer(Http, ask).pipe(Layer.provide(layer))`, not in the handler, so the tools share the routes' build ([Action-in-process.md](Action-in-process.md#share-one-build-across-servers)). A tool call runs as the request's caller, unless the handler provides another around it. Keep each caller's `Chat` in a service between requests ([kitchen-sink/src/assistant/conversations.ts](node_modules/@gjermundgaraba/effect-actions/examples/kitchen-sink/src/assistant/conversations.ts)), and answer an approval in a later one: [kitchen-sink/src/assistant/handlers.ts](node_modules/@gjermundgaraba/effect-actions/examples/kitchen-sink/src/assistant/handlers.ts), with a scripted model in [demo-model.ts](node_modules/@gjermundgaraba/effect-actions/examples/kitchen-sink/src/assistant/demo-model.ts), which the entrypoint provides through [kitchen-sink/src/memory.ts](node_modules/@gjermundgaraba/effect-actions/examples/kitchen-sink/src/memory.ts), and tested over HTTP in [kitchen-sink/test/assistant/assistant.test.ts](node_modules/@gjermundgaraba/effect-actions/examples/kitchen-sink/test/assistant/assistant.test.ts). Name the files as it does, the route's contract `Assistant.ts` and the loop `handlers.ts`, from the first one written: a lowercase `assistant.ts` beside the contract fails with TS1149 ([setup-failures.md](setup-failures.md)).
- **The real model comes later?** Provide a scripted one from the entrypoint until then, as the kitchen-sink does. Reading the model with `Effect.serviceOption` hides the requirement: the server builds without one and every request fails.

### Call a tool by hand

`yield* toolkit` gives `tools.handle(name, arguments)`, which takes the JSON a model sends, an
ISO string for a `Schema.Date`, and returns an Effect of a stream of results:
[assistant/test/toolkit.test.ts](node_modules/@gjermundgaraba/effect-actions/examples/assistant/test/toolkit.test.ts). The handler starts
when `handle` runs, so provide the caller around the whole
`handle(...).pipe(Effect.flatMap(Stream.runCollect))`, not around the stream alone. `handle`
never asks for approval.

## Name the caller

Provide the identity around each turn, or each call made by hand, as `actingFor` does in
[assistant/src/toolkit.ts](node_modules/@gjermundgaraba/effect-actions/examples/assistant/src/toolkit.ts): the approval rule, `authorize`
and the handlers of every call in the turn read it.

- Never provide an identity to `layer`, which is built once for every caller. It satisfies no protected tool's call, which still owes its own in its type, and it silently answers for any call that lacks one.
- A protected action's tool owes its identity whether or not its handler reads it ([Action.md](Action.md#say-who-may-call-an-action)).

## Ask for approval

`needsApproval` is one rule over every call a model makes, asked before the call runs. Every
write: `needsApproval: (call) => !call.action.readOnly`
([kitchen-sink/src/issues/assistant.ts](node_modules/@gjermundgaraba/effect-actions/examples/kitchen-sink/src/issues/assistant.ts)). A
rule reading the call's input and its caller:
[assistant/src/toolkit.ts](node_modules/@gjermundgaraba/effect-actions/examples/assistant/src/toolkit.ts).

- `call` is `{ name, action, input }`, the input decoded, over every action of the implementations, whatever `actions` lists. Check `call.name` to narrow the other two.
- The rule's `Effect` requires nothing: read the caller with `Effect.serviceOption`, and decide what the absence of one means.
- Its `Effect` cannot fail in its type, and one that fails anyway runs the call unapproved. To ask when a policy cannot be read, end it with `Effect.orElseSucceed(() => true)`.
- Approval is not authorization, which stays `authorize`. Only a model's turn asks for it, and `ActionMcp` has no such option.

A call that needs approval does not run: the turn ends with a `tool-approval-request` part in
`response.content` in place of its result. Start the next turn with the person's answers
([assistant/src/agent.ts](node_modules/@gjermundgaraba/effect-actions/examples/assistant/src/agent.ts)):

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
- An approved call runs in the answering turn, before the model is asked again, as whoever that turn runs as: provide the caller who was asked. `authorize` runs for it too ([assistant/test/toolkit.test.ts](node_modules/@gjermundgaraba/effect-actions/examples/assistant/test/toolkit.test.ts)).
- **Each request is answered on its own.** Of a turn's several requests, an approved call runs, a denied one (`approved: false`) does not and gives the model a failed result (`{ type: "execution-denied", reason }`, whose `reason` is `undefined` unless the answer gives one: not JSON: a route answering with it as a `Schema.Unknown` success answers an empty 500), and one left unanswered stays open for a later turn. To require every answer at once, check it in the host. Refuse an `approvalId` answered twice in one request: every answer is acted on, so its call would run twice. The answering turn's response does not repeat a request left open: list every open one with `ActionToolkit.openApprovals(yield* Ref.get(chat.history))`, as [kitchen-sink/src/assistant/handlers.ts](node_modules/@gjermundgaraba/effect-actions/examples/kitchen-sink/src/assistant/handlers.ts) does. Effect finds an approval's call by its tool-call id, which a provider makes unique: where a model of your own repeats one, the last call with it runs, which `openApprovals` names and `response.toolCalls` may not.
- **Continue on `toolCalls`, never on `toolResults`.** The answering turn's response holds the approved call's result, no tool call, and the model's reply to it: a loop that continues while a response has tool results asks the model again and loses that reply.
- **If a turn fails or is interrupted once an approved call has started**, the model failing or the client going away, the call may have run, and may run again. A failed `generateText` records nothing of its turn, so the same answer sent again runs the call again. A failed `streamText` records its prompt and the parts it streamed: a call that returned has its result recorded, but one that failed or was cut off while running leaves its answer without a result, which the next turn acts on unasked; `openApprovals` leaves that request out, as another answer would run the call twice. End the conversation where a turn does not succeed, or record an answer in your own store before its turn, and say in the error that an approved call may have run. Run one turn of a conversation at a time, and look it up again once the lock is held, so a turn that waited does not run on a conversation just ended: [kitchen-sink/src/assistant/conversations.ts](node_modules/@gjermundgaraba/effect-actions/examples/kitchen-sink/src/assistant/conversations.ts) does both.
- **Show the person what is asked.** A request names its call by `toolCallId`; that call, in `response.toolCalls`, holds the model's `params`, typed `unknown`. Show them as JSON, as [assistant/src/agent.ts](node_modules/@gjermundgaraba/effect-actions/examples/assistant/src/agent.ts) does, which joins the two; decode them with `Schema.toCodecJson(AddTask.input)`, the tool's parameters, only where you read a field.
- **If repeating a write would create an unwanted additional effect, retries need application-owned deduplication.** Keep the same operation key across attempts, as in [notes-service's creation example](node_modules/@gjermundgaraba/effect-actions/examples/notes-service/README.md#retry-a-creation). Approval history alone does not make the mutation and its result record atomic.
- **Only the person asked answers.** A `tool-approval-response` whose `approvalId` matches a request in the history without a result is acted on, as the turn's caller, an answered one included: take an `approvalId` only from that caller, among those `openApprovals` lists, and keep the `Chat` where its owner alone reaches it.
