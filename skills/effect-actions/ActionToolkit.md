# ActionToolkit

Implementations as Effect's native AI `Toolkit`: one tool per action, run in the process that
calls the model, with no server. Reach for it when a `LanguageModel` or a `Chat` in your program
calls your actions. Nothing authenticates: the host names the caller. Code of your own calls
the same implementations typed, with `Action.client`
([Action.md](Action.md#call-actions-in-process)).

A message the library throws says its fix; for a compiler diagnostic or Effect's own error, search [ActionToolkit-failures.md](ActionToolkit-failures.md). For one symbol, `grep -rn <symbol> node_modules/@gjermundgaraba/effect-actions/dist/`: each declaration's JSDoc carries its rules and gotchas, and this page only what an example cannot show.

## Give a model tools

`ActionToolkit.make` projects implementations into `{ toolkit, layer }`. Pass `toolkit` to
`LanguageModel.generateText` or a `Chat`, and provide `layer` once, around the program:

```ts example=assistant/src/toolkit.ts
import { Effect, Option } from "effect";
import { Tool, Toolkit } from "effect/ai";
import * as ActionToolkit from "@gjermundgaraba/effect-actions/ActionToolkit";
import { identity } from "./identity/handlers.js";
import { CurrentCaller, type Member } from "./identity/Identity.js";
import { tasks } from "./tasks/handlers.js";

// `actions.layer` holds the handlers, and requires the startup services their builders read;
// neither it nor `actions.toolkit` holds a caller.
const actions = ActionToolkit.make([tasks, identity], {
  // One rule over every call a model makes, asked before the call runs. A read runs at once. A
  // write waits for a person to approve it, except a task the caller adds to their own list:
  // `call.name` narrows `call.input` to that action's. Without a caller, it asks.
  needsApproval: (call) =>
    !call.action.readOnly &&
    Effect.map(
      Effect.serviceOption(CurrentCaller),
      Option.match({
        onNone: () => true,
        onSome: (caller) => call.name !== "addTask" || call.input.assignee !== caller.id,
      }),
    ),
});

// A title for this assistant's approval display. The model still calls the tool `addTask`.
// The later definition wins; annotating the generated tool keeps its handler and approval rule.
export const toolkit = Toolkit.merge(
  actions.toolkit,
  Toolkit.make(actions.toolkit.tools.addTask.annotate(Tool.Title, "Add a task")),
);

export const layer = actions.layer;

// One toolkit serves every member, so who a turn runs as is provided around that turn. This is
// how this example names a model's caller, and it takes a `Member`. The tools themselves accept
// any `CurrentCaller`, so keeping the operator away from a model is this function's doing, and
// that of every host using it.
export const actingFor = (member: Member) => Effect.provideService(CurrentCaller, member);
```

[assistant/src/agent.ts](node_modules/@gjermundgaraba/effect-actions/examples/assistant/src/agent.ts) runs the turns and provides `layer`
with its startup services, with a scripted model in
[assistant/src/scripted.ts](node_modules/@gjermundgaraba/effect-actions/examples/assistant/src/scripted.ts). What a call returns, a
refusal and arguments that do not decode included, is on `ActionToolkit.make`; the options'
rules are on `ActionToolkit.Options`.

- **Let the model read its tools' results** by asking again:
  [kitchen-sink/src/assistant/handlers.ts](node_modules/@gjermundgaraba/effect-actions/examples/kitchen-sink/src/assistant/handlers.ts).
- Where a model must not get every action, list the tools
  ([Action.md](Action.md#define-a-contract)):
  [kitchen-sink/src/issues/assistant.ts](node_modules/@gjermundgaraba/effect-actions/examples/kitchen-sink/src/issues/assistant.ts).
- A turn's tool calls, the approved calls of an answering turn included, run concurrently unless
  `generateText` is given a `concurrency`:
  [assistant/src/tasks/store.ts](node_modules/@gjermundgaraba/effect-actions/examples/assistant/src/tasks/store.ts) locks each change.
- **A model loop behind a route.** Yield `toolkit` and the model in the implementation's
  builder, and provide `layer` to the route's layer,
  `ActionHttp.layer(Http, ask).pipe(Layer.provide(layer))`, so the tools share the routes' build
  ([Action.md](Action.md#share-one-build-across-servers)):
  [kitchen-sink/src/assistant/handlers.ts](node_modules/@gjermundgaraba/effect-actions/examples/kitchen-sink/src/assistant/handlers.ts),
  keeping each caller's `Chat` in
  [conversations.ts](node_modules/@gjermundgaraba/effect-actions/examples/kitchen-sink/src/assistant/conversations.ts), with a scripted
  model in [demo-model.ts](node_modules/@gjermundgaraba/effect-actions/examples/kitchen-sink/src/assistant/demo-model.ts) that the
  entrypoint provides through [kitchen-sink/src/memory.ts](node_modules/@gjermundgaraba/effect-actions/examples/kitchen-sink/src/memory.ts),
  tested over HTTP in
  [kitchen-sink/test/assistant/assistant.test.ts](node_modules/@gjermundgaraba/effect-actions/examples/kitchen-sink/test/assistant/assistant.test.ts).
  Name the files as it does, the route's contract `Assistant.ts` and the loop `handlers.ts`,
  from the first one written.
- **The real model comes later?** Provide a scripted one from the entrypoint until then, as the
  kitchen-sink does. Reading the model with `Effect.serviceOption` hides the requirement: the
  server builds without one and every request fails.

### Customize the native tools

Give a generated tool a title, or other annotations, with native `Tool` and `Toolkit` from
`effect/ai`, as `toolkit` above does; [agent.ts](node_modules/@gjermundgaraba/effect-actions/examples/assistant/src/agent.ts) reads the
title when printing approval requests.

- To add other native tools, use `Toolkit.merge(toolkit, others)` and provide both handler layers
  with `Layer.mergeAll(layer, othersHandlers)`.

### Call a tool by hand

`yield* toolkit` gives `tools.handle(name, arguments)`:
[assistant/test/toolkit.test.ts](node_modules/@gjermundgaraba/effect-actions/examples/assistant/test/toolkit.test.ts). Its rules, where
to provide the caller among them, are on `ActionToolkit.Tools`.

## Name the caller

Provide the identity around each turn, or each call made by hand, as `actingFor` does in
[assistant/src/toolkit.ts](node_modules/@gjermundgaraba/effect-actions/examples/assistant/src/toolkit.ts). Why never to `layer`, and that
a protected tool owes it whatever its handler reads, are on `Action.Options.caller`
([Action.md](Action.md#say-who-may-call-an-action)).

## Ask for approval

To ask before every write: `needsApproval: (call) => !call.action.readOnly`
([kitchen-sink/src/issues/assistant.ts](node_modules/@gjermundgaraba/effect-actions/examples/kitchen-sink/src/issues/assistant.ts)). A
rule reading the call's input and its caller is `toolkit` above; its rules are on
`ActionToolkit.Options`.

A call that needs approval does not run: the turn ends with a `tool-approval-request` part in
`response.content` in place of its result. Start the next turn with the person's answers, in a
`Chat`, as the caller who was asked:
[assistant/src/agent.ts](node_modules/@gjermundgaraba/effect-actions/examples/assistant/src/agent.ts) shows both and says why, tested in
[assistant/test/toolkit.test.ts](node_modules/@gjermundgaraba/effect-actions/examples/assistant/test/toolkit.test.ts).

- **Each request is answered on its own**: an approved call runs, a denied one does not, and one
  left unanswered stays open for a later turn; to require every answer at once, check it in the
  host. List the open ones with `ActionToolkit.openApprovals(yield* Ref.get(chat.history))`.
  The kitchen-sink refuses an `approvalId` answered twice
  ([Assistant.ts](node_modules/@gjermundgaraba/effect-actions/examples/kitchen-sink/src/assistant/Assistant.ts)), gives each call its own
  id ([demo-model.ts](node_modules/@gjermundgaraba/effect-actions/examples/kitchen-sink/src/assistant/demo-model.ts)) and lets only its
  owner reach a conversation
  ([conversations.ts](node_modules/@gjermundgaraba/effect-actions/examples/kitchen-sink/src/assistant/conversations.ts)).
- A denied call's result, `{ type: "execution-denied", reason }`, has `reason` `undefined` unless
  the answer gives one, so it is not JSON: a route answering it as a `Schema.Unknown` success
  answers an empty 500.
- **If a turn fails or is interrupted once an approved call has started**, the call may have
  run: end the conversation and say so in the error, as
  [kitchen-sink/src/assistant/conversations.ts](node_modules/@gjermundgaraba/effect-actions/examples/kitchen-sink/src/assistant/conversations.ts)
  and [handlers.ts](node_modules/@gjermundgaraba/effect-actions/examples/kitchen-sink/src/assistant/handlers.ts) do. What a failed
  `streamText` leaves is on `ActionToolkit.openApprovals`.
- **Show the person what is asked**: [assistant/src/agent.ts](node_modules/@gjermundgaraba/effect-actions/examples/assistant/src/agent.ts)
  joins each request to its call by `toolCallId`; how to read the arguments is on
  `ActionToolkit.Approval`.
- **If repeating a write would create an unwanted additional effect, retries need
  application-owned deduplication.** Keep the same operation key across attempts, as in
  [notes-service's creation example](node_modules/@gjermundgaraba/effect-actions/examples/notes-service/README.md#retry-a-creation).
  Approval history alone does not make the mutation and its result record atomic.
