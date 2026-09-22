# ActionCli

Native Effect CLI commands that run handlers in-process. The host provides every service;
nothing is fetched over HTTP.

## API

```ts
import * as ActionCli from "@gjermundgaraba/effect-actions/ActionCli";

/** One explicitly selected action. */
const command: <G, Name extends G["actions"][number]["name"], H, EX, RX, EB, RB, Parameters = never>(
  app: Implementation<G, H, EX, RX>,
  name: Name,
  options?: Options<SuccessType, EB, RB, Parameters>,
) => Command.Command<string, never, {}, EX | EB | SchemaError | DeclaredErrors, Exclude<RX | RB | HandlerContext, Scope>>;

/** Every action of the group, including local-only ones, under the group name. */
const group: <G, H, EX, RX, EB, RB>(
  app: Implementation<G, H, EX, RX>,
  options?: GroupOptions<EB, RB>,
) => Command.Command<string, {}, {}, EX | EB | SchemaError | DeclaredErrors, ...>;

/** The hook both projections accept. A CLI encodes nothing, so it declares no errors. */
interface BeforeOptions<EB, RB> {
  readonly before?: (action: Action.Any) => Effect.Effect<void, EB, RB>;
}

interface GroupOptions<EB, RB> extends BeforeOptions<EB, RB> {
  readonly name?: string; // override the group command name
}

type Options<Output, EB, RB, Parameters extends Command.Command.Config = never> =
  | (JsonOptions<Output> & BeforeOptions<EB, RB>)
  | (ParametersOptions<Output, Parameters> & BeforeOptions<EB, RB>);

interface JsonOptions<Output> {
  readonly name?: string; // override the command name; default is the action name
  readonly render?: (output: Output) => string; // human output; adds a --json flag that selects JSON
}

interface ParametersOptions<Output, Parameters> {
  readonly name?: string;
  readonly render?: (output: Output) => string;
  readonly parameters: Parameters; // native Effect Flag / Argument config
  readonly input: (parsed: Command.Command.Config.InferValue<Parameters>) => Schema.Json; // encoded action input
}
```

## Canonical

```ts
import { Console, Effect, Logger } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import * as ActionCli from "@gjermundgaraba/effect-actions/ActionCli";
import { actors, authorize, CurrentActor } from "./auth.js";
import { UserApp } from "./handlers.js";
import { Users } from "./users.js";

// Explicit syntax: `double --value 21`. No `--input` on this command.
// The CLI binds the same hook as the servers; a local caller is not trusted more.
const command = ActionCli.command(UserApp, "double", {
  parameters: { value: Flag.String("value") },
  input: ({ value }) => ({ value }),
  before: authorize,
});

// Default syntax for a whole group: `users double --input '{"value":"21"}'`.
const all = ActionCli.group(UserApp, { before: authorize });

Command.runWith(command, { version: "0.1.0" })(process.argv.slice(2)).pipe(
  Effect.tapCause((cause) => Console.error(cause)),
  Effect.provideService(Logger.LogToStderr, true),
  // The hook runs here too, so a local caller supplies the identity it reads
  // exactly as HTTP middleware does for a request.
  Effect.provideService(CurrentActor, actors.alice),
  Effect.provide(Users.layerMemory),
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain({ disableErrorReporting: true }),
);
```

## Rules

- `command(app, name)` selects one action by name from the bound group; the name is checked at the type level. `group(app)` puts every action under the group command, including actions with `http: false` and `mcp: false`.
- Default syntax is `--input '<json>'` or `--input-file <path>` carrying the entire encoded input: nested objects, arrays, scalars. The file is read and JSON-parsed by the native `Flag.FileSchema`. Both are decoded by the native parser; if both are given, the file is used. Omitting both decodes `{}`; an action that requires input then fails with a `SchemaError`, exactly as a `parameters` command's mapped input does.
- `parameters` and `input` are supplied together or not at all. With them, the command has explicit native flags and arguments and neither `--input` nor `--input-file`, so its syntax does not change when the schema changes.
- `input(parsed)` returns encoded JSON. The action schema decodes it before dispatch; a mismatch is a `SchemaError` at runtime. Action fields are never turned into flags automatically.
- Native `Flag` and `Argument` own names, aliases, ordering, defaults, and optionality. Use `Flag.optional` when omission must stay distinct from a default, and map the `Option` to a present or omitted field.
- Output is validated and encoded before printing. Default output is JSON. `render(decoded)` gives human output and adds a `--json` flag to that command, which selects JSON again. Rendering cannot bypass validation.
- `--json` is a regular flag of the rendered command only, placed after the command name on a `group` path. A command without `render` has no such flag: its output is JSON already. Nothing is declared tree-wide, so a host CLI may declare its own `--json`, global or not. A rendered `parameters` command reserves the flag name; a payload field named `json` is ordinary data.
- Each invocation acquires the implementation in a scope and releases it after the call. Domain services and authority come from the host's provided layers. There is no HTTP fallback.
- `before` runs before the selected handler, on `command` and on every subcommand of `group`. Its failure joins the command's error channel and its services are the caller's to provide, so a local CLI supplies the identity the hook reads exactly as HTTP middleware does. A CLI is not a trusted bypass.
- The CLI declares no `errors`: it encodes nothing, so a refusal is simply a typed failure of the command effect. The native parser also decodes `--input` and `--input-file` before the command runs, so unlike HTTP the hook runs after input decoding.
- Group commands use the default JSON syntax. For a custom tree, compose individual `command` results with native `Command` combinators.

## Failure modes

- `SchemaError` on a valid-looking `--input`: the JSON is decoded input, so transforming codecs expect the encoded form (`"21"` for `FiniteFromString`, not `21`).
- Command rejects `--input` or `--input-file`: the command was built with `parameters`. Use its flags.
- Type error: `name` is not an action of the group. Check `group.actions` names, not MCP tool names.
- Handler cannot find a service: provide its Layer to the runtime (`Effect.provide`) before `runMain`. The command does not supply services.
- A command requires a request-identity tag no handler yields: the `before` hook yields it. Provide it, or build the command without a hook for local use.
- `--json` flag conflict at definition on a rendered `parameters` command: rename the native flag; the config property can keep its name.
