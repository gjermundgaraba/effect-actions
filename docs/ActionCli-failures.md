# ActionCli failure modes

What you see when something is wrong, and the fix. Search for a fragment of the message. The tasks are in [ActionCli.md](ActionCli.md).

## Flags and input

- `Unrecognized flag: --<field> in command …` for an input field: a field listed in `positional` has no flag. Pass its value as an argument.
- `Missing value for flag --<flag>`, or `Unrecognized flag: -x`, for a value starting with `-`: Effect's parser reads a value written apart from its flag as a flag itself when it starts with `-`, `-` alone and a number such as `-5` excepted, so `--note -x` is a missing value and `--note --help` prints help. Write `--<flag>=<value>`; `--` does not help, since what follows it is positional.

## Types

- An argument of type `Binding<…>` not assignable at `make` or `command`, an implementation not assignable at `remote` or `remoteCommand`, or `client` refused at `make` or `command`: `make` and `command` take implementations, `remote` and `remoteCommand` a binding and alone `client`. To choose by a condition, build a command from each: `remotely ? ActionCli.remote(Http, options) : ActionCli.make(users, options)`.
- `Type 'HttpClient' is not assignable to type 'never'` in the pipe that runs a remote command: provide `NodeHttpClient.layerUndici` (or `FetchHttpClient.layer`). Another service named there is what its `client` requires: provide it too.
- An argument of type `Binding<…>` not assignable at `remote` or `remoteCommand`, beside a `client`: the client is another binding's. Make it with `ActionHttp.client` of this one.
- Type error at `Effect.catchTag("UserNotFound", ...)` after `Command.run`: a command fails with `UserError`. Use `Effect.catchReason("UserError", "UserNotFound", ...)`.
- Type error at `Effect.catchReason("UserError", "<Tag>", ...)`, its tag typed `never`: a failure of the command has no `_tag`, such as a builder's plain `Error`. Fail with a tagged error, such as a `Schema.TaggedError` or `Data.TaggedError`.
- `Argument of type 'string | undefined' is not assignable` at a `UserError`'s `userMessage`: it is optional on the type. Read it with `?? ""`, or assert it with `toHaveProperty`.

## Running

- `ConfigError: …` or another error's `Tag: message` on stderr from a remote command, a public one too: its `client` failed, as when a required token is not set. Read an optional one with `Config.option` and add the header only when it is there; where every command needs it, map the failure to a tagged error whose `message` says what to do ([notes-service/src/commands.ts](../examples/notes-service/src/commands.ts)).
- `HttpClientError` whose `reason._tag` is `InvalidUrlError`, from a remote command: its client has no `baseUrl` and prepends no URL. Give `ActionHttp.client` a `baseUrl` in the `client` option.
- A report with a stack on stdout, `ERROR (#1): ...`, instead of JSON on stderr: a defect, or a failure of a layer the host provides, which `runMain` reports. Fix the defect; apply `ActionCli.logToStderr` to keep such reports off stdout.
- `ERROR (#n)` with a stack for a declared error, such as `UserNotFound`, from a command built with `Command.make`: a command of your own that calls `Action.client` or `ActionHttp.client` fails with the action's own error. Pipe its whole Effect through `ActionCli.toUserError`, given the binding or the actions it calls, or derive the command with `ActionCli.command`.
