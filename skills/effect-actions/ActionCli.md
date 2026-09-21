# ActionCli

Native Effect CLI commands that run handlers in-process. The host provides every service;
nothing is fetched over HTTP.

## API

```ts
import * as ActionCli from "@gjermundgaraba/effect-actions/ActionCli";

/** One explicitly selected action. */
const command: <G, Name extends G["actions"][number]["name"], H, EX, RX, RB, Parameters = never>(
  app: Implementation<G, H, EX, RX, RB>,
  name: Name,
  options?: Options<SuccessType, Parameters>,
) => Command.Command<string, never, {}, EX | SchemaError | DeclaredErrors, Exclude<RX | RB | HandlerContext, Scope>>;

/** Every action of the group, including local-only ones, under the group name. */
const group: <G, H, EX, RX, RB>(
  app: Implementation<G, H, EX, RX, RB>,
  options?: GroupOptions,
) => Command.Command<string, {}, {}, EX | SchemaError | DeclaredErrors, ...>;

interface GroupOptions {
  readonly name?: string; // override the group command name
}

type Options<Output, Parameters extends Command.Command.Config = never> =
  | JsonOptions<Output>
  | ParametersOptions<Output, Parameters>;

interface JsonOptions<Output> {
  readonly name?: string; // override the command name; default is the action name
  readonly render?: (output: Output) => string; // human output; --json still prints JSON
}

interface ParametersOptions<Output, Parameters> {
  readonly name?: string;
  readonly render?: (output: Output) => string;
  readonly parameters: Parameters; // native Effect Flag / Argument config
  readonly input: (parsed: Command.Command.Config.Infer<Parameters>) => Schema.Json; // encoded action input
}
```

## Canonical

```ts
import { Console, Effect, Logger } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import * as ActionCli from "@gjermundgaraba/effect-actions/ActionCli";
import { actors, CurrentActor } from "./auth.js";
import { UserApp } from "./handlers.js";
import { Users } from "./users.js";

// Explicit syntax: `double --value 21`. No `--input` on this command.
const command = ActionCli.command(UserApp, "double", {
  parameters: { value: Flag.String("value") },
  input: ({ value }) => ({ value }),
});

// Default syntax for a whole group: `users double --input '{"value":"21"}'`.
const all = ActionCli.group(UserApp);

Command.runWith(command, { version: "0.1.0" })(process.argv.slice(2)).pipe(
  Effect.tapCause((cause) => Console.error(cause)),
  Effect.provideService(Logger.LogToStderr, true),
  // The group's `before` hook runs here too, so a local caller supplies the
  // identity it reads exactly as HTTP middleware does for a request.
  Effect.provideService(CurrentActor, actors.alice),
  Effect.provide(Users.layerMemory),
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain({ disableErrorReporting: true }),
);
```

## Rules

- `command(app, name)` selects one action by name from the bound group; the name is checked at the type level. `group(app)` puts every action under the group command, including actions with `http: false` and `mcp: false`.
- Default syntax is `--input '<json>'` carrying the entire encoded input: nested objects, arrays, scalars. Omitting `--input` supplies `{}`, which must still satisfy the input schema.
- `parameters` and `input` are supplied together or not at all. With them, the command has explicit native flags and arguments and no `--input`, so its syntax does not change when the schema changes.
- `input(parsed)` returns encoded JSON. The action schema decodes it before dispatch; a mismatch is a `SchemaError` at runtime. Action fields are never turned into flags automatically.
- Native `Flag` and `Argument` own names, aliases, ordering, defaults, and optionality. Use `Flag.optional` when omission must stay distinct from a default, and map the `Option` to a present or omitted field.
- Output is validated and encoded before printing. Default output is JSON. `render(decoded)` gives human output; `--json` selects JSON again. Rendering cannot bypass validation.
- Explicit flag names must not collide with the renderer's `--json` flag. A payload field named `json` is ordinary data; only the flag name is reserved.
- Each invocation acquires the implementation in a scope and releases it after the call. Domain services and authority come from the host's provided layers. There is no HTTP fallback.
- The group's pre-handler hook runs here too, before every command's handler. Its services are the caller's to provide, so a local CLI supplies the identity the hook reads exactly as HTTP middleware does. A CLI is not a trusted bypass.
- Group commands use the default JSON syntax. For a custom tree, compose individual `command` results with native `Command` combinators.

## Failure modes

- `SchemaError` on a valid-looking `--input`: the JSON is decoded input, so transforming codecs expect the encoded form (`"21"` for `FiniteFromString`, not `21`).
- Command rejects `--input`: the command was built with `parameters`. Use its flags.
- Type error: `name` is not an action of the group. Check `group.actions` names, not MCP tool names.
- Handler cannot find a service: provide its Layer to the runtime (`Effect.provide`) before `runMain`. The command does not supply services.
- A command requires a request-identity tag no handler yields: the group's `before` hook yields it. Provide it, or bind a separate implementation without the hook for local use.
- `--json` flag conflict at definition: rename the native flag; the config property can keep its name.
