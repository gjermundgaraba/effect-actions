# assistant

An application with no server: its actions run in the process that calls them. A team's task
list is worked on by a model, through tools, and by whoever runs the machine, through commands.
Both are the same implementations behind the same authorization. It opens no port.

Start here if a model calls your code in process (an agent, a chat bot, a job), or if you are
building a local command-line tool. For a service others call over the network, start from
[notes-service](../notes-service/).

## Run it

From the repository root, after `vp install`:

```sh
node --import tsx examples/assistant/src/agent.ts               # a scripted model: no API key

node --import tsx examples/assistant/src/cli.ts --help
node --import tsx examples/assistant/src/cli.ts list-tasks      # what the model added
node --import tsx examples/assistant/src/cli.ts add-task --title "Pay the caterer" --assignee grace
node --import tsx examples/assistant/src/cli.ts complete-task 1
echo "Vegetarian for six." | node --import tsx examples/assistant/src/cli.ts annotate-task --id 3
node --import tsx examples/assistant/src/cli.ts list-tasks -a grace --json 2>/dev/null

vp test examples/assistant
```

The agent and each command are separate processes. They share one JSON file, named by
`ASSISTANT_TASKS` and kept in the system's temporary directory by default. Running the agent
again adds the same tasks again: delete the file to start over. The model is scripted, the
members and their permissions are fixed tables, and nothing locks the file between processes:
replace all three before relying on any of it.

## Layout

```text
src/
├── tasks/
│   ├── Tasks.ts         contract: schemas, an error, four actions
│   ├── store.ts         TaskStore and its Layers: memory, and a JSON file
│   └── handlers.ts      Action.implement: contract to store
├── identity/
│   ├── Identity.ts      contract: CurrentCaller, a Member or the Operator; whoAmI
│   ├── permissions.ts   Permissions, the store the authorizer reads
│   ├── authorize.ts     the one authorization rule, built from Permissions
│   ├── members.ts       the demo team
│   └── handlers.ts
├── toolkit.ts           the implementations as a Toolkit, and which calls need approval
├── commands.ts          the implementations as commands, and each command's syntax
├── scripted.ts          a model that needs no API key
├── agent.ts             entrypoint: a model calling the tools, as a member
└── cli.ts               entrypoint: the commands, as the operator
test/
├── tasks/               the implementation in process, with Action.client; the file store
├── identity/            the authorizer: a caller per call, the permission store once
├── toolkit.test.ts      a tool call, approvals, an approved call still authorized
└── commands.test.ts     the commands run in memory: syntax and output
```

- **Two surfaces, no transport.** `toolkit.ts` and `commands.ts` take the same implementations.
  Neither holds a caller or a store: `agent.ts` and `cli.ts` provide those, and so does a test.
- **The caller comes from the host, per call.** Nothing here authenticates anyone. `agent.ts`
  provides the member around each turn; `cli.ts` provides the operator on the command. A caller
  is never given to the toolkit's `layer`, which is built once for every member.
- **The operator is a type, not a flag.** `Member | Operator` is what an action may be called
  as. Only `cli.ts` builds an `Operator`, and the demo team is typed as members, so no sign-in
  produces one. A model's caller is named through `actingFor`, which takes a `Member`. The tools
  themselves accept either: keeping the operator away from a model is the host's doing.
- **Approval is not authorization.** `needsApproval` decides which of a model's calls wait for a
  person. `authorize` decides who may call at all, and runs for an approved call too.

## Where to look

| To see                                                               | Read                               |
| -------------------------------------------------------------------- | ---------------------------------- |
| Implementations as a native Effect AI `Toolkit`                      | `src/toolkit.ts`                   |
| One approval rule reading the call and its caller                    | `src/toolkit.ts`                   |
| A turn run as a member, and an approval answered through a `Chat`    | `src/agent.ts`                     |
| Where a real `LanguageModel` plugs in                                | `src/agent.ts`, `src/scripted.ts`  |
| Local commands with `positional`, `aliases`, `render`, `stdin`       | `src/commands.ts`                  |
| Services provided on the command, and the host naming the caller     | `src/cli.ts`                       |
| A command's result alone on stdout, its handler's logs on stderr     | `src/cli.ts`, `src/tasks/store.ts` |
| `logToStderr` moving a defect's report from stdout to stderr         | `src/cli.ts`                       |
| An identity only the host builds: the trusted operator               | `src/identity/Identity.ts`         |
| An authorizer built once from a service, reading the caller per call | `src/identity/authorize.ts`        |
| One service with two Layers, chosen by the entrypoint                | `src/tasks/store.ts`               |
| Changes serialized, since a turn's tool calls run concurrently       | `src/tasks/store.ts`               |
| Testing handlers and authorization, each caller around its calls     | `test/tasks/tasks.test.ts`         |
| Testing a Layer over a temporary file, its path set through config   | `test/tasks/store.test.ts`         |
| Testing a tool call, an approval required, an approval answered      | `test/toolkit.test.ts`             |
| Testing a command's syntax and output without a process              | `test/commands.test.ts`            |
