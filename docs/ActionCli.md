# ActionCli

Native Effect CLI commands for actions, with flags derived from each action's input. `make` and `command` take implementations and run the handler in the command's own process, behind the same `authorize`: for a local tool, or an operator console that has the services itself. `remote` and `remoteCommand` take an HTTP binding and call a server, running nothing locally: for users of a service you already serve. `make` and `remote` derive one command per action; which actions a surface serves is on `Action.make`.

A message the library throws says its fix; for a compiler diagnostic or Effect's own error, search [ActionCli-failures.md](ActionCli-failures.md). For one symbol, `grep -rn <symbol> node_modules/@gjermundgaraba/effect-actions/dist/`: each declaration's JSDoc carries its rules and gotchas, and this page only what an example cannot show.

## Run actions as local commands

Pass implementations to `make`; the host provides the services and the caller on the command, and runs it with Effect's own `Command.run`:

```ts example=assistant/src/cli.ts
import { userInfo } from "node:os";

import { NodeRuntime, NodeServices } from "@effect/platform-node";
import * as ActionCli from "@gjermundgaraba/effect-actions/ActionCli";
import { Effect, Layer } from "effect";
import { Command } from "effect/cli";

import { commands } from "./commands.js";
import { CurrentCaller } from "./identity/Identity.js";
import type { Operator } from "./identity/Identity.js";
import { Permissions } from "./identity/permissions.js";
import { tasksFile } from "./platform/tasks-file.js";

// Entrypoint: `node --import tsx examples/assistant/src/cli.ts list-tasks`.
// The operator's own tool. No credential arrives at a terminal, so this host names the caller
// itself: whoever runs the command, as the trusted operator. Being local earns nothing more:
// `authorize` runs here as for a model's tool call, and admits the operator by its kind.
const operator: Operator = { kind: "operator", id: userInfo().username };

const assistant = commands.pipe(
  Command.provide(Layer.mergeAll(tasksFile, Permissions.layerMemory)),
  Command.provideSync(CurrentCaller, operator)
);

// A command's defect, such as a tasks file that does not decode, `runMain` reports on stdout.
// `logToStderr`, applied last, moves that to stderr, so `assistant list-tasks --json | jq` reads
// results alone.
Command.run(assistant, { version: "1.0.0" }).pipe(
  Effect.provide(NodeServices.layer),
  ActionCli.logToStderr,
  NodeRuntime.runMain()
);
```

The aggregate is [assistant/src/commands.ts](../examples/assistant/src/commands.ts), and [kitchen-sink/src/ops.ts](../examples/kitchen-sink/src/ops.ts) an operator console. For one action, or a tree of your own under native `Command.withSubcommands`, use `command(implementations, action, options?)`. Where services go, what each run builds and what a command prints on which stream are on `ActionCli.command`; what `runMain` reports, a command's defect included, on `ActionCli.logToStderr`; matching a failure after `Command.run`, on `ActionCli.UserError`.

- **Test commands without a process** with `Command.runWith`, `TestConsole` and `Stdio.layerTest`: [assistant/test/commands.test.ts](../examples/assistant/test/commands.test.ts).

## Call a server from commands

Pass the HTTP binding to `remote`. The program imports the binding alone, never a handler. The connection is the `client` option, an `ActionHttp.client` ([ActionHttp.md](ActionHttp.md#call-the-api-from-effect)), its rules on `ActionCli.Calling`'s `client`, shared by `remote` and `remoteCommand`: [notes-service/src/commands.ts](../examples/notes-service/src/commands.ts) requires a token, mapping its absence to an error that says what to do, and [kitchen-sink/src/cli.ts](../examples/kitchen-sink/src/cli.ts) adds a tenant header, reads an optional token for a public command. The host provides `HttpClient` (`NodeHttpClient.layerUndici`) in [notes-service/src/cli.ts](../examples/notes-service/src/cli.ts).

- **Split one binding into groups of commands**, one `remote` per group with its own `actions`; what each group's `client` needs is on `ActionCli.Calling`'s `client`.
- **Test a remote command the same way** as a local one, with `Testing.layer(routes)` provided as its `HttpClient` ([Testing.md](Testing.md#test-routes-in-memory)). Export the command from a module apart from the entrypoint that runs it ([notes-service/test/commands.test.ts](../examples/notes-service/test/commands.test.ts)).

## Watch events

`make` and `remote` add `watch <event>` for each [event type](Event.md) among the implementations or in the binding, or each one `actions` lists where it is given. Experimental, as [events](Event.md) are.

```ts example=build-events/src/commands.ts
import * as ActionCli from "@gjermundgaraba/effect-actions/ActionCli";
import * as ActionHttp from "@gjermundgaraba/effect-actions/ActionHttp";
import { Config, Effect } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";

import { Http } from "./Api.js";

// The binding's client, connected to where the server is and as which member, both read from
// config when a command runs.
const api = Effect.gen(function* () {
  const baseUrl = yield* Config.String("BUILDS_URL").pipe(
    Config.withDefault("http://127.0.0.1:3000")
  );

  const token = yield* Config.Redacted("BUILDS_TOKEN");

  return yield* ActionHttp.client(Http, {
    baseUrl,
    transformClient: HttpClient.mapRequest(
      HttpClientRequest.bearerToken(token)
    ),
  });
});

// A command per action, and `watch <event>` per event type: `builds watch build.finished
// --pipeline api` holds the event's stream open and prints each occurrence as a line of JSON,
// its `cursor` included, until it is stopped. `--cursor <cursor>` resumes after that line;
// omitted, the watch starts from now. The lines pipe into `jq` or a script as they come.
// `builds start-build --pipeline api` prints each step as a line of JSON on stderr as it
// starts, and the build on stdout, which a pipe reads alone. `builds tail-log --build-id
// build-1` prints each line of its log as a line of JSON as it arrives.
export const commands = ActionCli.remote(Http, { name: "builds", client: api });
```

[build-events/test/commands.test.ts](../examples/build-events/test/commands.test.ts) runs a watch and stops it. What a watch prints and fails with is on `make` and `remote`.

## Shape flags, input and output

### Flags from the input

A struct or class input gets one flag per top-level field, named after the field in kebab case, with the field's description as its help, annotated before or after its checks. The field's encoded JSON value decides the kind of flag:

| Encoded field | Flag, for a field `tags`, `read`, … |
| --- | --- |
| string or template literal | `--name <string>` |
| boolean | `--read`, a switch: `--no-read` or `--read=false` sends `false` |
| union of string literals, or string enum | `--kind <choice>`, one of the values |
| array of strings, numbers or choices | `--tags <value>`, repeated: one element per occurrence |
| anything else, numbers included | `--owner <value>`: JSON the field accepts, or else the text |

- A switch left out is `false` for a required field, and leaves an optional one out.
- `--help` adds, after the field's description, `Repeat for each value.` on a repeated flag, `--no-read sends false.` on an optional switch, `Left out, it sends false.` on a required one, and `A JSON array.` or `A JSON object.` on a value that is one, an array of objects with its fields: `A JSON array of {id, approved?}.`
- A flag takes the encoded value, which the action's schema then decodes: `"21"` for `Schema.FiniteFromString`.
- A value flag reads its text as JSON when the field accepts that kind of JSON value (`--count 2`, `--owner '{"id":"x"}'`, `--points '[{"x":1}]'`), and keeps it as text otherwise (`--limit auto`): quote a string that would read as JSON, `--id '"123"'` for a `String | Number` field.
- A repeated flag given no occurrence sends `[]` for a required `Schema.Array` field, and leaves an optional field out, where `--tags '[]'` alone sends an empty list.
- An input that is not a struct of named fields (a union, a record, a scalar) gets one `--input <value>` flag carrying the whole encoded input. Left off, the input is `{}`.

### Arguments, short flags and stdin

`description`, `render`, `positional`, `aliases` and `stdin` shape one command; in an aggregate they go under `commands`, keyed by the action's name. Each one's rules are on its own declaration:

```ts example=assistant/src/commands.ts
import * as ActionCli from "@gjermundgaraba/effect-actions/ActionCli";

import { identity } from "./identity/handlers.js";
import { tasks } from "./tasks/handlers.js";

// The same implementations as local commands, `assistant <action>`: a command runs the handler
// in this process, behind the same `authorize`. `add-task` and `who-am-i` are as derived; the
// others each change their syntax or output.
export const commands = ActionCli.make([tasks, identity], {
  name: "assistant",
  commands: {
    // `assistant list-tasks -a ada`: a short flag beside `--assignee`. `render` prints a line
    // per task for a person, and adds `--json` for the JSON a script reads. `description` is the
    // command's help, saying what a line holds; the action's stays what a model reads.
    listTasks: {
      description:
        "Print one line per task: [x] when done, then its id, title and assignee.",
      aliases: { assignee: "a" },
      render: ({ tasks: listed }) =>
        listed
          .map(
            (task) =>
              `${task.done ? "[x]" : "[ ]"} ${task.id} ${task.title} (${task.assignee})`
          )
          .join("\n"),
    },
    // `assistant complete-task 2`: an argument instead of `--id 2`.
    completeTask: { positional: ["id"] },
    // `assistant annotate-task --id 2 < notes.md`: the notes are piped in, not a flag.
    annotateTask: { stdin: "notes" },
  },
});
```

### Add a command of your own

Work every surface should offer, a bulk import for one, is an action first: a command of your own then only reads the file and calls it. For a syntax the options cannot express, such as a flag named apart from its field, build the command with native `Command.make`, `Flag` and `Argument`, and pass it in `subcommands`, whose rules are on `ActionCli.Options`; pipe its Effect through `toUserError` to fail as a derived command does. In [notes-service/src/commands.ts](../examples/notes-service/src/commands.ts), `notes import <file>` reads `Argument.FileText` and calls `importNotes`, and `notes export <file>` takes `Argument.String("file")` and calls two actions.

## Name the caller

`Command.provideSync(CurrentCaller, operator)` names the caller on the command in [assistant/src/cli.ts](../examples/assistant/src/cli.ts), or `Command.provideEffect(CurrentCaller, load)` reads it when an action runs ([Action.md](Action.md#say-who-may-call-an-action)).

- **A trusted operator is a type, not a flag.** Give the identity a variant only a host builds, kept out of every verifier's return type, and admit it in the shared `authorize`: [assistant/src/identity/Identity.ts](../examples/assistant/src/identity/Identity.ts) with [assistant/src/identity/authorize.ts](../examples/assistant/src/identity/authorize.ts), or [kitchen-sink/src/admin/Admin.ts](../examples/kitchen-sink/src/admin/Admin.ts) with [kitchen-sink/src/ops.ts](../examples/kitchen-sink/src/ops.ts).
