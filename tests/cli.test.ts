import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, onTestFinished, vi } from "vite-plus/test";
import { Cause, Effect, Exit, Schema, type Scope } from "effect";
import { CliError, Command, Flag, GlobalFlag } from "effect/unstable/cli";
import { NodeFileSystem } from "@effect/platform-node";
import * as Action from "../src/Action.js";
import * as ActionCli from "../src/ActionCli.js";
import * as ActionGroup from "../src/ActionGroup.js";
import { cliServices, logged } from "./cli-services.js";

const run = <Name extends string, Input, Context, E>(
  command: Command.Command<Name, Input, Context, E, Scope.Scope>,
  args: ReadonlyArray<string>,
) =>
  Effect.runPromise(
    Effect.scoped(
      Command.runWith(command, { version: "0" })(args).pipe(Effect.provide(cliServices)),
    ),
  );

const runExit = <Name extends string, Input, Context, E>(
  command: Command.Command<Name, Input, Context, E, Scope.Scope>,
  args: ReadonlyArray<string>,
) =>
  Effect.runPromise(
    Effect.scoped(
      Command.runWith(command, { version: "0" })(args).pipe(
        Effect.provide(cliServices),
        Effect.exit,
      ),
    ),
  );

it("uses --input canonical JSON and supplies {} for no-input actions", async () => {
  const inputs: number[] = [];

  const NumberAction = Action.make("number", {
    description: "Accept an encoded finite number",
    access: "write",
    input: Schema.Struct({ value: Schema.FiniteFromString }),
    success: Schema.FiniteFromString,
  });

  const Empty = Action.make("empty", {
    description: "No input",
    access: "write",
    success: Schema.String,
  });

  const empties: object[] = [];

  const app = ActionGroup.make({ name: "local" }, NumberAction, Empty).implement({
    number: ({ value }) =>
      Effect.andThen(
        Effect.sync(() => inputs.push(value)),
        () => Effect.succeed(value * 2),
      ),
    empty: (input) =>
      Effect.andThen(
        Effect.sync(() => empties.push(input)),
        () => Effect.succeed("empty"),
      ),
  });

  await run(ActionCli.command(app, "number"), ["--input", '{"value":"21"}']);
  const empty = ActionCli.command(app, "empty");
  await run(empty, []);
  await run(empty, []);

  expect(inputs).toEqual([21]);
  // The built-in no-input codec receives a fresh default each invocation.
  expect(empties).toEqual([{}, {}]);
  expect(empties[0]).not.toBe(empties[1]);
});

it("maps explicit native parameters to canonical JSON without an implicit --input mode", async () => {
  const inputs: number[] = [];

  const NumberAction = Action.make("number", {
    description: "Accept a finite number",
    access: "write",
    input: Schema.Struct({ value: Schema.FiniteFromString }),
    success: Schema.Number,
  });

  const app = ActionGroup.make({ name: "configured" }, NumberAction).implement({
    number: ({ value }) =>
      Effect.andThen(
        Effect.sync(() => inputs.push(value)),
        () => Effect.succeed(value * 2),
      ),
  });

  const command = ActionCli.command(app, "number", {
    parameters: { value: Flag.String("value") },
    input: ({ value }) => ({ value }),
  });

  await run(command, ["--value", "21"]);
  expect(inputs).toEqual([21]);
  expect(Exit.isFailure(await runExit(command, ["--input", '{"value":"22"}']))).toBe(true);
});

it("maps canonical JSON strings to codecs whose original encoding is not JSON", async () => {
  const inputs: Date[] = [];

  const Dated = Action.make("dated", {
    description: "Receives a decoded date",
    access: "write",
    input: Schema.Struct({ at: Schema.Date }),
    success: Schema.String,
  });

  const app = ActionGroup.make({ name: "dated" }, Dated).implement({
    dated: ({ at }) =>
      Effect.andThen(
        Effect.sync(() => inputs.push(at)),
        () => Effect.succeed(at.toISOString()),
      ),
  });

  const command = ActionCli.command(app, "dated", {
    parameters: { at: Flag.String("at") },
    input: ({ at }) => ({ at }),
  });

  await run(command, ["--at", "2026-01-02T03:04:05.000Z"]);
  expect(inputs.map((date) => date.toISOString())).toEqual(["2026-01-02T03:04:05.000Z"]);
});

it("rejects invalid mapped input before acquiring or invoking the handler", async () => {
  let builds = 0;
  let calls = 0;

  const NumberAction = Action.make("number", {
    description: "A finite number",
    access: "write",
    input: Schema.Struct({ value: Schema.FiniteFromString }),
    success: Schema.Number,
  });

  const app = ActionGroup.make({ name: "invalid-input" }, NumberAction).implement(
    Effect.sync(() => {
      builds++;

      return {
        number: () =>
          Effect.andThen(
            Effect.sync(() => calls++),
            () => Effect.succeed(1),
          ),
      };
    }),
  );

  const command = ActionCli.command(app, "number", {
    parameters: { value: Flag.String("value") },
    input: ({ value }) => ({ value }),
  });

  expect(Exit.isFailure(await runExit(command, ["--value", "not-a-number"]))).toBe(true);
  expect(builds).toBe(0);
  expect(calls).toBe(0);
});

it("accepts scalar and nested default JSON and rejects malformed or missing required input", async () => {
  const values: unknown[] = [];

  const Scalar = Action.make("scalar", {
    description: "Scalar input",
    access: "write",
    input: Schema.String,
    success: Schema.String,
  });

  const Nested = Action.make("nested", {
    description: "Nested input",
    access: "write",
    input: Schema.Struct({ nested: Schema.Struct({ value: Schema.Number }) }),
    success: Schema.String,
  });

  const Required = Action.make("required", {
    description: "Required input",
    access: "write",
    input: Schema.Struct({ value: Schema.String }),
    success: Schema.String,
  });

  const app = ActionGroup.make({ name: "json" }, Scalar, Nested, Required).implement({
    scalar: (input) =>
      Effect.andThen(
        Effect.sync(() => values.push(input)),
        () => Effect.succeed("scalar"),
      ),
    nested: (input) =>
      Effect.andThen(
        Effect.sync(() => values.push(input)),
        () => Effect.succeed("nested"),
      ),
    required: ({ value }) => Effect.succeed(value),
  });

  await run(ActionCli.command(app, "scalar"), ["--input", '"text"']);
  await run(ActionCli.command(app, "nested"), ["--input", '{"nested":{"value":1}}']);
  const malformed = await runExit(ActionCli.command(app, "required"), ["--input", "{"]);
  expect(Exit.isFailure(malformed)).toBe(true);

  if (Exit.isFailure(malformed)) {
    const error = Cause.squash(malformed.cause);
    expect(error).toBeInstanceOf(CliError.ShowHelp);

    if (error instanceof CliError.ShowHelp) {
      expect(error.errors[0]).toBeInstanceOf(CliError.InvalidValue);
    }
  }

  const omitted = await runExit(ActionCli.command(app, "required"), []);
  expect(Exit.isFailure(omitted)).toBe(true);

  if (Exit.isFailure(omitted)) {
    expect(Cause.squash(omitted.cause)).toBeInstanceOf(Schema.SchemaError);
  }

  expect(values).toEqual(["text", { nested: { value: 1 } }]);
});

it("keeps custom renderer JSON output and validates success before rendering", async () => {
  let rendered = 0;

  const Rendered = Action.make("rendered", {
    description: "Renders",
    access: "write",
    success: Schema.String,
  });

  const app = ActionGroup.make({ name: "rendered" }, Rendered).implement({
    rendered: () => Effect.succeed("value"),
  });

  const command = ActionCli.command(app, "rendered", {
    render: (value) => `${++rendered}:${value}`,
  });

  const [, output] = await Effect.runPromise(
    Effect.scoped(
      logged(Command.runWith(command, { version: "0" })(["--json"])).pipe(
        Effect.provide(cliServices),
      ),
    ),
  );

  expect(rendered).toBe(0);
  expect(output).toEqual(['"value"']);

  const invalidRenderer = vi.fn((value: number) => String(value));

  const Invalid = Action.make("invalid", {
    description: "Invalid",
    access: "write",
    success: Schema.Finite,
  });

  const invalid = ActionGroup.make({ name: "invalid" }, Invalid).implement({
    invalid: () => Effect.succeed(Infinity),
  });

  expect(
    Exit.isFailure(
      await runExit(ActionCli.command(invalid, "invalid", { render: invalidRenderer }), []),
    ),
  ).toBe(true);
  expect(invalidRenderer).not.toHaveBeenCalled();
});

it("keeps native parameter property names separate from renderer flag names", async () => {
  const inputs: string[] = [];

  const Configured = Action.make("configured", {
    description: "A config property named json uses a distinct native flag",
    access: "write",
    input: Schema.Struct({ value: Schema.String }),
    success: Schema.String,
  });

  const app = ActionGroup.make({ name: "collision" }, Configured).implement({
    configured: ({ value }) =>
      Effect.andThen(
        Effect.sync(() => inputs.push(value)),
        () => Effect.succeed(value),
      ),
  });

  const command = ActionCli.command(app, "configured", {
    parameters: { json: Flag.String("payload-json") },
    input: ({ json }) => ({ value: json }),
    render: (value) => value,
  });

  await run(command, ["--payload-json", "value", "--json"]);
  expect(inputs).toEqual(["value"]);
});

it("runs local-only actions, scopes every invocation, and exposes group subcommands", async () => {
  let acquired = 0;
  let released = 0;
  const inputs: string[] = [];

  const Local = Action.make("local", {
    description: "Never projected to HTTP or MCP",
    access: "write",
    input: Schema.Struct({ value: Schema.String }),
    success: Schema.String,
    http: false,
    mcp: false,
  });

  const Other = Action.make("other", {
    description: "Another action",
    access: "write",
    success: Schema.String,
  });

  const group = ActionGroup.make({ name: "locals" }, Local, Other);

  const app = group.implement(
    Effect.acquireRelease(
      Effect.sync(() => {
        acquired++;

        return {
          local: ({ value }: { readonly value: string }) =>
            Effect.andThen(
              Effect.sync(() => inputs.push(value)),
              () => Effect.succeed(value),
            ),
          other: () => Effect.succeed("other"),
        };
      }),
      () =>
        Effect.sync(() => {
          released++;
        }),
    ),
  );

  await run(ActionCli.command(app, "local"), ["--input", '{"value":"direct"}']);
  await run(ActionCli.group(app), ["local", "--input", '{"value":"group"}']);

  expect(inputs).toEqual(["direct", "group"]);
  expect(acquired).toBe(2);
  expect(released).toBe(2);
});

it("reads the whole canonical input from --input-file, which takes precedence over --input", async () => {
  const inputs: number[] = [];

  const NumberAction = Action.make("number", {
    description: "Accept an encoded finite number",
    access: "write",
    input: Schema.Struct({ value: Schema.FiniteFromString }),
    success: Schema.Number,
  });

  const app = ActionGroup.make({ name: "file" }, NumberAction).implement({
    number: ({ value }) =>
      Effect.andThen(
        Effect.sync(() => inputs.push(value)),
        () => Effect.succeed(value * 2),
      ),
  });

  const directory = await mkdtemp(join(tmpdir(), "effect-actions-"));
  onTestFinished(() => rm(directory, { recursive: true }));
  const file = join(directory, "input.json");
  await writeFile(file, '{"value":"21"}');
  const invalid = join(directory, "invalid.json");
  await writeFile(invalid, '{"value":"x"}');

  const command = ActionCli.command(app, "number");

  const exit = (args: ReadonlyArray<string>) =>
    Effect.runPromise(
      Effect.scoped(
        Command.runWith(command, { version: "0" })(args).pipe(
          Effect.provide(NodeFileSystem.layer),
          Effect.provide(cliServices),
          Effect.exit,
        ),
      ),
    );

  expect(Exit.isSuccess(await exit(["--input-file", file]))).toBe(true);
  expect(inputs).toEqual([21]);

  // A malformed file is its own error, not a fallback to the inline default.
  expect(Exit.isFailure(await exit(["--input-file", invalid]))).toBe(true);

  // A file takes precedence over inline input, which is still validated.
  expect(Exit.isSuccess(await exit(["--input-file", file, "--input", '{"value":"1"}']))).toBe(true);
  expect(Exit.isFailure(await exit(["--input-file", file, "--input", "{"]))).toBe(true);
  expect(inputs).toEqual([21, 21]);
});

it("adds --json only to a command with a renderer, without contesting a host's own --json", async () => {
  const Plain = Action.make("plain", {
    description: "No renderer",
    access: "read",
    success: Schema.String,
  });

  const Pretty = Action.make("pretty", {
    description: "Rendered",
    access: "read",
    success: Schema.String,
  });

  const app = ActionGroup.make({ name: "output" }, Plain, Pretty).implement({
    plain: () => Effect.succeed("plain"),
    pretty: () => Effect.succeed("pretty"),
  });

  const lines = <Name extends string, Input, Context, E>(
    command: Command.Command<Name, Input, Context, E, Scope.Scope>,
    args: ReadonlyArray<string>,
  ) =>
    Effect.runPromise(
      Effect.scoped(
        logged(Command.runWith(command, { version: "0" })(args)).pipe(Effect.provide(cliServices)),
      ),
    ).then(([, output]) => output);

  const pretty = ActionCli.command(app, "pretty", { render: (value) => `rendered ${value}` });
  expect(await lines(pretty, [])).toEqual(["rendered pretty"]);
  expect(await lines(pretty, ["--json"])).toEqual(['"pretty"']);
  // Without a renderer the output is JSON already, and the flag does not exist:
  // the native parser treats it as unknown and shows help.
  expect(await lines(ActionCli.command(app, "plain"), [])).toEqual(['"plain"']);
  await expect(lines(ActionCli.command(app, "plain"), ["--json"])).rejects.toThrow(
    "Help requested",
  );

  // A regular flag: a host that declares `--json` itself, globally or on a
  // parent, still composes; the projected command keeps its own.
  const HostJson = GlobalFlag.Setting("host-json")({
    flag: Flag.Boolean("json").pipe(Flag.withDefault(false)),
  });

  const hosted = Command.make("host", { json: Flag.Boolean("json") }).pipe(
    Command.withSubcommands([pretty, ActionCli.group(app)]),
    Command.withGlobalFlags([HostJson]),
  );

  expect(await lines(hosted, ["pretty", "--json"])).toEqual(['"pretty"']);
  expect(await lines(hosted, ["output", "plain"])).toEqual(['"plain"']);
});
