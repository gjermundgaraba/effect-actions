# ActionCli

Native Effect CLI commands that run handlers in-process. The host provides every service;
nothing is fetched over HTTP. Any action runs locally, whether or not HTTP or MCP serves it.

## API

Import `@gjermundgaraba/effect-actions/ActionCli`.

| API                            | Purpose                                           |
| ------------------------------ | ------------------------------------------------- |
| `command(app, name, options?)` | One selected action as a native Effect `Command`. |
| `group(app, options?)`         | Every action under a group command.               |
| `Options`, `GroupOptions`      | Configuration for single and aggregate commands.  |

| Option                | Meaning                                                                                                      |
| --------------------- | ------------------------------------------------------------------------------------------------------------ |
| `name`                | Override the command/group name.                                                                             |
| `before`              | Hook receiving the selected `Action.Any`; its failures and services join the command's channels.             |
| `render`              | Single command only: decoded success to human-readable string; adds `--json`.                                |
| `parameters`, `input` | Single command only; supply together. Native flag/argument config and parsed-config-to-encoded-JSON mapping. |

Without `parameters`/`input`, a command accepts `--input` and `--input-file`. Commands retain
handler, builder and hook requirements/failures, plus codec failures. The invocation owns its
scope. Success output is encoded; failures remain failures of the command Effect.

## Canonical

```ts
import { Console, Effect, Logger } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import * as ActionCli from "@gjermundgaraba/effect-actions/ActionCli";
import { actors, authorize, CurrentActor } from "./auth.js";
import { UserApp } from "./handlers.js";
import { Users } from "./users.js";

// The CLI binds the same hook as the servers; a local caller is not trusted more.
const command = ActionCli.command(UserApp, "double", {
  parameters: { value: Flag.String("value") },
  input: ({ value }) => ({ value }),
  before: authorize,
});

Command.runWith(command, { version: "0.1.0" })(process.argv.slice(2)).pipe(
  Effect.tapCause((cause) => Console.error(cause)),
  Effect.provideService(Logger.LogToStderr, true),
  // The hook runs here too, so a local caller supplies an identity for it
  // exactly as HTTP middleware does for a request.
  Effect.provideService(CurrentActor, actors.alice),
  Effect.provide(Users.layerMemory),
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain({ disableErrorReporting: true }),
);
```

## Rules

- `command(app, name)` selects one action by name from the bound group; the name is checked at the type level. `group(app)` puts every action under the group command, including actions with `mcp: false` and groups no HTTP binding serves.
- Default syntax is `--input '<json>'` or `--input-file <path>` carrying the entire encoded input: nested objects, arrays, scalars. The file is read and JSON-parsed by the native `Flag.FileSchema`. Both are decoded by the native parser; if both are given, the file is used. Omitting both decodes `{}` separately on every invocation; result identity follows the codec's behavior. An action that requires input then fails with a `SchemaError`, exactly as a `parameters` command's mapped input does.
- `parameters` and `input` are supplied together or not at all. With them, the command has explicit native flags and arguments and neither `--input` nor `--input-file`, so its syntax does not change when the schema changes.
- `input(parsed)` returns encoded JSON. The action schema decodes it before dispatch; a mismatch is a `SchemaError` at runtime. Action fields are never turned into flags automatically.
- Native `Flag` and `Argument` own names, aliases, ordering, defaults, and optionality. Use `Flag.optional` when omission must stay distinct from a default, and map the `Option` to a present or omitted field.
- Output is validated and encoded before printing. Default output is JSON. `render(decoded)` gives human output and adds a `--json` flag to that command, which selects JSON again. Rendering cannot bypass validation.
- `--json` is a regular flag of the rendered command only, placed after the command name on a `group` path. A command without `render` has no such flag: its output is JSON already. Nothing is declared tree-wide, so a host CLI may declare its own `--json`, global or not. A rendered `parameters` command reserves the flag name; a payload field named `json` is ordinary data.
- Each invocation acquires the implementation in a scope and releases it after the call. Domain services and authority come from the host's provided layers. There is no HTTP fallback.
- `before` runs before the selected handler, on `command` and on every subcommand of `group`. Its failure joins the command's error channel and its services are the caller's to provide, so a local CLI supplies the identity the hook reads exactly as HTTP middleware does. A CLI is not a trusted bypass.
- The CLI declares no surface `errors`: it does not serialize failures, so a refusal is simply a typed failure of the command effect. Success values are still validated and encoded for output. The native parser also decodes `--input` and `--input-file` before the command runs, so invalid input skips the hook and handler.
- Group commands use the default JSON syntax. For a custom tree, compose individual `command` results with native `Command` combinators.

## Failure modes

- Native `CliError.ShowHelp` containing `InvalidValue` for a supplied `--input` or `--input-file`: the parser rejected its JSON or schema before the command handler ran. Supply encoded input (`"21"` for `FiniteFromString`, not `21`). With neither flag, decoding the default `{}` can fail with `SchemaError`; so can a `parameters` command's mapped input or an invalid success value.
- Command rejects `--input` or `--input-file`: the command was built with `parameters`. Use its flags.
- Type error: `name` is not an action of the group. Check `group.actions` names, not MCP tool names.
- Handler cannot find a service: provide its Layer to the runtime (`Effect.provide`) before `runMain`. The command does not supply services.
- A command requires a request-identity tag no handler yields: the `before` hook yields it. Provide a trusted identity around the invocation; do not remove the authorization hook just to satisfy the service requirement.
- `--json` flag conflict at definition on a rendered `parameters` command: rename the native flag; the config property can keep its name.
