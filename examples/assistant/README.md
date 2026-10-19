# assistant

An application with no server: its actions run in the process that calls them. A team's task
list is worked on by a model, through tools, and by whoever runs the machine, through commands.
Both are the same implementations behind the same authorization. It opens no port.

Start here if a model calls your code in process (an agent, a chat bot, a job), or if you are
building a local command-line tool. For a service others call over the network, start from
[notes-service](../notes-service/).

## Run it

From the repository root, after `vp install` (from an installed package, see
[Run one](../README.md#run-one)):

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
│   ├── store.ts         TaskStore, its constructor and its memory Layer
│   └── handlers.ts      Action.implement: contract to store
├── identity/
│   ├── Identity.ts      contract: CurrentCaller, a Member or the Operator; whoAmI
│   ├── permissions.ts   Permissions, the store the authorizer reads
│   ├── authorize.ts     the one authorization rule, built from Permissions
│   ├── members.ts       the demo team
│   └── handlers.ts
├── platform/
│   └── tasks-file.ts    DEMO ONLY: TaskStore's Layer over a JSON file
├── toolkit.ts           the implementations as a Toolkit, and which calls need approval
├── commands.ts          the implementations as commands, and each command's syntax
├── scripted.ts          a model that needs no API key
├── agent.ts             entrypoint: a model calling the tools, as a member
└── cli.ts               entrypoint: the commands, as the operator
test/
├── tasks/               the implementation in process, with Action.client
├── platform/            the file store, on a file of the test's own
├── identity/            the authorizer: a caller per call, the permission store once
├── toolkit.test.ts      a tool call, approvals, an approved call still authorized
└── commands.test.ts     the commands run in memory: syntax and output
```

## Where to look

| To see                                                               | Read                                               |
| -------------------------------------------------------------------- | -------------------------------------------------- |
| Implementations as a native Effect AI `Toolkit`                      | `src/toolkit.ts`                                   |
| Native tool titles in the approval display                           | `src/toolkit.ts`, `src/agent.ts`                   |
| One approval rule reading the call and its caller                    | `src/toolkit.ts`                                   |
| A turn run as a member, and an approval answered through a `Chat`    | `src/agent.ts`                                     |
| Where a real `LanguageModel` plugs in                                | `src/agent.ts`, `src/scripted.ts`                  |
| Local commands with `positional`, `aliases`, `render`, `stdin`       | `src/commands.ts`                                  |
| Services provided on the command, and the host naming the caller     | `src/cli.ts`                                       |
| A command's result alone on stdout, its handler's logs on stderr     | `src/cli.ts`, `src/platform/tasks-file.ts`         |
| `logToStderr` moving a defect's report from stdout to stderr         | `src/cli.ts`                                       |
| An identity only the host builds: the trusted operator               | `src/identity/Identity.ts`                         |
| An authorizer built once from a service, reading the caller per call | `src/identity/authorize.ts`                        |
| One service with two Layers, chosen by the entrypoint                | `src/tasks/store.ts`, `src/platform/tasks-file.ts` |
| Changes serialized, since a turn's tool calls run concurrently       | `src/tasks/store.ts`                               |
| Testing handlers and authorization, each caller around its calls     | `test/tasks/tasks.test.ts`                         |
| Testing a Layer over a temporary file, its path set through config   | `test/platform/tasks-file.test.ts`                 |
| Testing a tool call, an approval required, an approval answered      | `test/toolkit.test.ts`                             |
| Testing a command's syntax and output without a process              | `test/commands.test.ts`                            |
