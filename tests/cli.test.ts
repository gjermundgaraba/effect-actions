import { expect, it, vi } from "vite-plus/test";
import { Console, Effect, Exit, Schema, type Scope } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import * as Action from "../src/Action.js";
import * as ActionCli from "../src/ActionCli.js";
import * as ActionGroup from "../src/ActionGroup.js";
import { capturingConsole, cliServices } from "./cli-services.js";

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
  expect(Exit.isFailure(await runExit(ActionCli.command(app, "required"), ["--input", "{"]))).toBe(
    true,
  );
  expect(Exit.isFailure(await runExit(ActionCli.command(app, "required"), []))).toBe(true);

  expect(values).toEqual(["text", { nested: { value: 1 } }]);
});

it("keeps custom renderer JSON output and validates success before rendering", async () => {
  const output: string[] = [];

  const capturedConsole = capturingConsole(output);

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
