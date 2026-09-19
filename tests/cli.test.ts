import { expect, it, vi } from "vite-plus/test";
import {
  Console,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Option,
  Path,
  Schema,
  type Scope,
  Stdio,
  Terminal,
} from "effect";
import { Argument, Command, Flag } from "effect/unstable/cli";
import { ChildProcessSpawner } from "effect/unstable/process";
import * as Action from "../src/Action.js";
import * as ActionCli from "../src/ActionCli.js";
import * as ActionGroup from "../src/ActionGroup.js";

const cliServices = Layer.merge(
  Layer.merge(FileSystem.layerNoop({}), Path.layer),
  Layer.merge(
    Stdio.layerTest({}),
    Layer.merge(
      Layer.succeed(
        Terminal.Terminal,
        Terminal.make({
          columns: Effect.succeed(80),
          rows: Effect.succeed(24),
          readInput: Effect.die("unused"),
          readLine: Effect.die("unused"),
          display: () => Effect.void,
        }),
      ),
      Layer.succeed(
        ChildProcessSpawner.ChildProcessSpawner,
        ChildProcessSpawner.make(() => Effect.die("unused")),
      ),
    ),
  ),
);

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
    input: Schema.Struct({ value: Schema.FiniteFromString }),
    success: Schema.FiniteFromString,
  });

  const Empty = Action.make("empty", { description: "No input", success: Schema.String });

  const app = ActionGroup.make({ name: "local" }, NumberAction, Empty).implement({
    number: ({ value }) =>
      Effect.andThen(
        Effect.sync(() => inputs.push(value)),
        () => Effect.succeed(value * 2),
      ),
    empty: () => Effect.succeed("empty"),
  });

  await run(ActionCli.command(app, "number"), ["--input", '{"value":"21"}']);
  await run(ActionCli.command(app, "empty"), []);

  expect(inputs).toEqual([21]);
});

it("maps explicit native parameters to canonical JSON without an implicit --input mode", async () => {
  const inputs: number[] = [];

  const NumberAction = Action.make("number", {
    description: "Accept a finite number",
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

it("preserves native argument order rather than action property order", async () => {
  const inputs: Array<{ first: string; second: string }> = [];

  const Ordered = Action.make("ordered", {
    description: "Ordered native arguments",
    input: Schema.Struct({ first: Schema.String, second: Schema.String }),
    success: Schema.String,
  });

  const app = ActionGroup.make({ name: "ordered" }, Ordered).implement({
    ordered: (input) =>
      Effect.andThen(
        Effect.sync(() => inputs.push(input)),
        () => Effect.succeed(`${input.first}:${input.second}`),
      ),
  });

  const command = ActionCli.command(app, "ordered", {
    parameters: { second: Argument.String("second"), first: Argument.String("first") },
    input: ({ first, second }) => ({ first, second }),
  });

  await run(command, ["two", "one"]);
  expect(inputs).toEqual([{ first: "one", second: "two" }]);
});

it("maps absent, true, and false native optional booleans explicitly", async () => {
  const inputs: Array<{ readonly enabled?: boolean }> = [];

  const Optional = Action.make("optional", {
    description: "Optional native boolean",
    input: Schema.Struct({ enabled: Schema.optionalKey(Schema.Boolean) }),
    success: Schema.String,
  });

  const app = ActionGroup.make({ name: "optional" }, Optional).implement({
    optional: (input) =>
      Effect.andThen(
        Effect.sync(() => inputs.push(input)),
        () => Effect.succeed("ok"),
      ),
  });

  const command = ActionCli.command(app, "optional", {
    parameters: { enabled: Flag.Boolean("enabled").pipe(Flag.optional) },
    input: ({ enabled }) => (Option.isSome(enabled) ? { enabled: enabled.value } : {}),
  });

  await run(command, []);
  await run(command, ["--enabled"]);
  await run(command, ["--no-enabled"]);

  expect(inputs).toEqual([{}, { enabled: true }, { enabled: false }]);
});

it("keeps explicit native flags for optional nested input", async () => {
  const inputs: Array<{ readonly settings?: { readonly enabled: boolean } }> = [];

  const Nested = Action.make("nested", {
    description: "Optional nested input",
    input: Schema.Struct({
      settings: Schema.optionalKey(Schema.Struct({ enabled: Schema.Boolean })),
    }),
    success: Schema.String,
  });

  const app = ActionGroup.make({ name: "nested" }, Nested).implement({
    nested: (input) =>
      Effect.andThen(
        Effect.sync(() => inputs.push(input)),
        () => Effect.succeed("ok"),
      ),
  });

  const command = ActionCli.command(app, "nested", {
    parameters: { enabled: Flag.Boolean("enabled") },
    input: ({ enabled }) => ({ settings: { enabled } }),
  });

  await run(command, ["--enabled"]);
  expect(inputs).toEqual([{ settings: { enabled: true } }]);
});

it("rejects invalid mapped input before acquiring or invoking the handler", async () => {
  let builds = 0;
  let calls = 0;

  const NumberAction = Action.make("number", {
    description: "A finite number",
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
    input: Schema.String,
    success: Schema.String,
  });

  const Nested = Action.make("nested", {
    description: "Nested input",
    input: Schema.Struct({ nested: Schema.Struct({ value: Schema.Number }) }),
    success: Schema.String,
  });

  const Required = Action.make("required", {
    description: "Required input",
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
  expect(Exit.isFailure(await runExit(ActionCli.command(app, "required"), ["--input", "{"]))).toBe(
    true,
  );
  expect(Exit.isFailure(await runExit(ActionCli.command(app, "required"), []))).toBe(true);

  expect(values).toEqual(["text", { nested: { value: 1 } }]);
});

it("keeps custom renderer JSON output and validates success before rendering", async () => {
  const output: string[] = [];

  const capturedConsole = {
    assert: console.assert.bind(console),
    clear: console.clear.bind(console),
    count: console.count.bind(console),
    countReset: console.countReset.bind(console),
    debug: console.debug.bind(console),
    dir: console.dir.bind(console),
    dirxml: console.dirxml.bind(console),
    error: console.error.bind(console),
    group: console.group.bind(console),
    groupCollapsed: console.groupCollapsed.bind(console),
    groupEnd: console.groupEnd.bind(console),
    info: console.info.bind(console),
    log: (message: string) => output.push(message),
    table: console.table.bind(console),
    time: console.time.bind(console),
    timeEnd: console.timeEnd.bind(console),
    timeLog: console.timeLog.bind(console),
    trace: console.trace.bind(console),
    warn: console.warn.bind(console),
  } satisfies Console.Console;

  let rendered = 0;
  const Rendered = Action.make("rendered", { description: "Renders", success: Schema.String });

  const app = ActionGroup.make({ name: "rendered" }, Rendered).implement({
    rendered: () => Effect.succeed("value"),
  });

  const command = ActionCli.command(app, "rendered", {
    render: (value) => `${++rendered}:${value}`,
  });

  await Effect.runPromise(
    Effect.scoped(
      Command.runWith(command, { version: "0" })(["--json"]).pipe(
        Effect.provide(cliServices),
        Effect.provideService(Console.Console, capturedConsole),
      ),
    ),
  );
  expect(rendered).toBe(0);
  expect(output).toEqual(['"value"']);

  const invalidRenderer = vi.fn((value: number) => String(value));
  const Invalid = Action.make("invalid", { description: "Invalid", success: Schema.Finite });

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
    input: Schema.Struct({ value: Schema.String }),
    success: Schema.String,
    http: false,
    mcp: false,
  });

  const Other = Action.make("other", { description: "Another action", success: Schema.String });
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
