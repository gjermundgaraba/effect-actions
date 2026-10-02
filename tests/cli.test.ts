import { spawnSync } from "node:child_process";
import { expect, it, vi } from "vite-plus/test";
import {
  Cause,
  Console,
  Context,
  Data,
  Effect,
  Exit,
  flow,
  Layer,
  Logger,
  Match,
  Option,
  Runtime,
  Schema,
  SchemaGetter,
  SchemaTransformation,
} from "effect";
import { TestConsole } from "effect/testing";
import { CliError, CliOutput, Command, Flag, GlobalFlag } from "effect/cli";
import { HttpClient } from "effect/http";
import * as Action from "../src/Action.js";
import * as ActionCli from "../src/ActionCli.js";
import * as ActionHttp from "../src/ActionHttp.js";
import * as ActionToolkit from "../src/ActionToolkit.js";
import { causeOf, cliServices, printed } from "./cli-services.js";
import { post } from "./requests.js";
import { clientLayer, serve } from "./serve.js";

/** Run `command` with `args` on the test CLI services. */
const exec = <Name extends string, Input, Context, E>(
  command: Command.Command<Name, Input, Context, E, never>,
  args: ReadonlyArray<string>,
) => Command.runWith(command, { version: "0" })(args).pipe(Effect.provide(cliServices));

const run = flow(exec, Effect.runPromise);

const runExit = flow(exec, Effect.runPromiseExit);

/** Every line a successful run logs. */
const lines = flow(
  exec,
  Effect.andThen(TestConsole.logLines),
  Effect.provide(TestConsole.layer),
  Effect.runPromise,
);

/** The typed failure of a failed run: the command's own, or the native parser's. */
const failure = <A, E>(exit: Exit.Exit<A, E>): E | undefined =>
  Option.getOrUndefined(Exit.findErrorOption(exit));

it("takes one flag per input field and no flags for an action without input", async () => {
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

  const app = Action.implement(
    [NumberAction, Empty],
    {
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
    },
    Action.allowAll,
  );

  // `FiniteFromString` is string-encoded, so its flag is a string flag.
  const number = ActionCli.command(app, NumberAction);
  await run(number, ["--value", "21"]);
  // A struct input takes no whole-input flag.
  expect(failure(await runExit(number, ["--input", '{"value":"22"}']))).toBeInstanceOf(
    CliError.ShowHelp,
  );

  const empty = ActionCli.command(app, Empty);
  await run(empty, []);
  await run(empty, []);
  expect(failure(await runExit(empty, ["--input", "{}"]))).toBeInstanceOf(CliError.ShowHelp);

  expect(inputs).toEqual([21]);
  // The no-input codec receives a fresh default each invocation.
  expect(empties).toEqual([{}, {}]);
  expect(empties[0]).not.toBe(empties[1]);
});

it("derives each field's flag from its encoded JSON value", async () => {
  const inputs: unknown[] = [];

  const Flags = Action.make("flags", {
    description: "One field of every kind",
    access: "write",
    input: {
      tenantId: Schema.String,
      count: Schema.Finite,
      dryRun: Schema.Boolean,
      verbose: Schema.optionalKey(Schema.Boolean),
      mode: Schema.Literals(["fast", "safe"]),
      tags: Schema.Array(Schema.String),
      owner: Schema.Struct({ id: Schema.String }),
      note: Schema.optionalKey(Schema.String),
    },
    success: Schema.String,
  });

  const app = Action.implement(
    Flags,
    (input) =>
      Effect.andThen(
        Effect.sync(() => inputs.push(input)),
        () => Effect.succeed("ok"),
      ),
    Action.allowAll,
  );

  const command = ActionCli.command(app, Flags);

  await run(command, [
    "--tenant-id",
    "acme",
    "--count",
    "2.5",
    "--dry-run",
    "--verbose",
    "--mode",
    "fast",
    "--tags",
    '["a","b"]',
    "--owner",
    '{"id":"alice"}',
    "--note",
    "hi",
  ]);

  // An omitted required boolean is a switch left off; an omitted optional field is absent.
  await run(command, [
    "--tenant-id",
    "acme",
    "--count",
    "1",
    "--mode",
    "safe",
    "--tags",
    "[]",
    "--owner",
    '{"id":"bob"}',
  ]);

  expect(inputs).toStrictEqual([
    {
      tenantId: "acme",
      count: 2.5,
      dryRun: true,
      verbose: true,
      mode: "fast",
      tags: ["a", "b"],
      owner: { id: "alice" },
      note: "hi",
    },
    { tenantId: "acme", count: 1, dryRun: false, mode: "safe", tags: [], owner: { id: "bob" } },
  ]);

  const required = ["--count", "1", "--mode", "fast", "--owner", '{"id":"a"}'];

  // A choice is parsed natively: another value shows help.
  const slow = failure(
    await runExit(command, [
      "--tenant-id",
      "acme",
      "--count",
      "1",
      "--mode",
      "slow",
      "--tags",
      "[]",
      "--owner",
      "{}",
    ]),
  );

  expect(slow).toBeInstanceOf(CliError.ShowHelp);

  if (slow instanceof CliError.ShowHelp) {
    expect(slow.errors[0]).toBeInstanceOf(CliError.InvalidValue);
  }

  // Any other flag takes JSON, or its text when it is not JSON, for the schema to decode:
  // input it refuses is `InvalidInput`, as over HTTP, naming the field.
  for (const [field, args] of [
    // The required flags, `--count` given text that is not JSON.
    ["count", ["--tenant-id", "acme", "--tags", "[]", ...required.with(1, "many")]],
    ["tags", ["--tenant-id", "acme", "--tags", "[", ...required]],
  ] as const) {
    const refused = causeOf(await runExit(command, args));

    expect(refused).toBeInstanceOf(Action.InvalidInput);

    if (refused instanceof Action.InvalidInput)
      expect(refused.message).toContain(`at ["${field}"]`);
  }

  // A required field's flag is required by the parser, which shows help without it.
  const missing = failure(await runExit(command, ["--tags", "[]", ...required]));
  expect(missing).toBeInstanceOf(CliError.ShowHelp);

  if (missing instanceof CliError.ShowHelp) {
    expect(missing.errors).toEqual([new CliError.MissingOption({ option: "tenant-id" })]);
  }

  // A JSON flag holding JSON of the wrong shape is invalid input as well.
  expect(
    causeOf(await runExit(command, ["--tenant-id", "acme", "--tags", "[1]", ...required])),
  ).toBeInstanceOf(Action.InvalidInput);

  // An undeclared field in a JSON flag is refused, not dropped: a misspelling is an error.
  expect(
    causeOf(
      await runExit(command, [
        "--tenant-id",
        "acme",
        "--count",
        "1",
        "--mode",
        "fast",
        "--tags",
        "[]",
        "--owner",
        '{"id":"a","nmae":"Ada"}',
      ]),
    ),
  ).toBeInstanceOf(Action.InvalidInput);

  expect(inputs).toHaveLength(2);
});

it("keeps JSON that breaks a rule as JSON, for the schema to report the rule and its path", async () => {
  const inputs: unknown[] = [];

  const Ruled = Action.make("ruled", {
    description: "Fields with rules beyond their kind",
    access: "write",
    input: {
      tags: Schema.Union([Schema.String, Schema.Array(Schema.String).check(Schema.isMaxLength(3))]),
      width: Schema.Int.check(Schema.isGreaterThan(0)),
      owner: Schema.Struct({ id: Schema.String }),
    },
  });

  const command = ActionCli.command(
    Action.implement(Ruled, (input) => Effect.sync(() => void inputs.push(input)), Action.allowAll),
    Ruled,
  );

  const valid = ["--width", "2", "--owner", '{"id":"a"}'];

  // Four tags break the rule: invalid input, never the JSON's text taken as a string.
  const tags = causeOf(await runExit(command, ["--tags", '["a","b","c","d"]', ...valid]));
  expect(tags).toBeInstanceOf(Action.InvalidInput);

  // The schema's own message and path, not "Expected number" or "Expected object".
  const width = causeOf(
    await runExit(command, ["--tags", "x", "--width", "1.5", "--owner", '{"id":"a"}']),
  );

  expect(width).toBeInstanceOf(Action.InvalidInput);

  if (width instanceof Action.InvalidInput) expect(width.message).toContain("Expected an integer");

  const owner = causeOf(await runExit(command, ["--tags", "x", "--width", "2", "--owner", "{}"]));
  expect(owner).toBeInstanceOf(Action.InvalidInput);

  if (owner instanceof Action.InvalidInput) expect(owner.message).toContain('["owner"]["id"]');

  // Text of a kind the field does not take is still text: a plain string here.
  await run(command, ["--tags", "a,b", ...valid]);
  expect(inputs).toEqual([{ tags: "a,b", width: 2, owner: { id: "a" } }]);
});

it("takes an enum's value and a template literal's text as they are, not as JSON", async () => {
  const inputs: unknown[] = [];

  const Enums = Action.make("enums", {
    description: "Enum and template-literal fields",
    access: "write",
    input: {
      color: Schema.Enum({ Red: "red", Blue: "blue" }),
      level: Schema.Enum({ Low: 1, High: 2 }),
      id: Schema.TemplateLiteral(["id-", Schema.Number]),
    },
  });

  const command = ActionCli.command(
    Action.implement(Enums, (input) => Effect.sync(() => void inputs.push(input)), Action.allowAll),
    Enums,
  );

  await run(command, ["--color", "red", "--level", "2", "--id", "id-7"]);
  expect(inputs).toStrictEqual([{ color: "red", level: 2, id: "id-7" }]);

  // A string enum is a choice, parsed natively: another value shows help.
  const error = failure(
    await runExit(command, ["--color", "green", "--level", "2", "--id", "id-7"]),
  );

  expect(error).toBeInstanceOf(CliError.ShowHelp);

  // The template's pattern is the action's schema's to check.
  expect(
    causeOf(await runExit(command, ["--color", "red", "--level", "2", "--id", "seven"])),
  ).toBeInstanceOf(Action.InvalidInput);
});

// A suspended schema, as a recursive one is written, is read as the schema it stands for.
it("reads a suspended input or field as the schema it stands for, described by it", async () => {
  const inputs: unknown[] = [];

  const Note = Action.make("note", {
    description: "A suspended input of suspended fields",
    access: "write",
    input: Schema.suspend(() =>
      Schema.Struct({
        text: Schema.suspend(() => Schema.String.annotate({ description: "What to note" })),
        // Described on the suspension it stands for, itself suspended.
        pinned: Schema.suspend(() =>
          Schema.suspend(() => Schema.Boolean).annotate({ description: "Keep it on top" }),
        ),
      }),
    ),
  });

  const app = Action.implement(
    Note,
    (input) =>
      Effect.sync(() => {
        inputs.push(input);
      }),
    Action.allowAll,
  );

  // A string field takes `true` as text, a boolean one is a switch, and a field may be
  // positional.
  await run(ActionCli.command(app, Note), ["--text", "true", "--pinned"]);
  await run(ActionCli.command(app, Note, { positional: ["text"] }), ["true"]);

  expect(inputs).toStrictEqual([
    { text: "true", pinned: true },
    { text: "true", pinned: false },
  ]);

  const help = (await lines(ActionCli.command(app, Note), ["--help"])).join("\n");
  expect(help).toMatch(/--text string\s+What to note/);
  expect(help).toMatch(/--pinned\s+Keep it on top/);
});

it("maps flag strings to codecs whose original encoding is not JSON", async () => {
  const inputs: Date[] = [];

  const Dated = Action.make("dated", {
    description: "Receives a decoded date",
    access: "write",
    input: Schema.Struct({ at: Schema.Date }),
    success: Schema.String,
  });

  const app = Action.implement(
    [Dated],
    {
      dated: ({ at }) =>
        Effect.andThen(
          Effect.sync(() => inputs.push(at)),
          () => Effect.succeed(at.toISOString()),
        ),
    },
    Action.allowAll,
  );

  await run(ActionCli.command(app, Dated), ["--at", "2026-01-02T03:04:05.000Z"]);
  expect(inputs.map((date) => date.toISOString())).toEqual(["2026-01-02T03:04:05.000Z"]);
});

it("rejects invalid input before acquiring or invoking the handler", async () => {
  let builds = 0;
  let calls = 0;

  const NumberAction = Action.make("number", {
    description: "A finite number",
    access: "write",
    input: Schema.Struct({ value: Schema.FiniteFromString }),
    success: Schema.Number,
  });

  const app = Action.implement(
    [NumberAction],
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
    Action.allowAll,
  );

  const command = ActionCli.command(app, NumberAction);

  expect(causeOf(await runExit(command, ["--value", "not-a-number"]))).toBeInstanceOf(
    Action.InvalidInput,
  );
  expect(builds).toBe(0);
  expect(calls).toBe(0);
});

it("takes an input that is not a struct of fields as one --input JSON flag", async () => {
  const values: unknown[] = [];

  const Scalar = Action.make("scalar", {
    description: "Scalar input",
    access: "write",
    input: Schema.String,
    success: Schema.String,
  });

  const Shape = Action.make("shape", {
    description: "A union root",
    access: "write",
    input: Schema.Union([
      Schema.Struct({ kind: Schema.Literal("circle"), radius: Schema.Finite }),
      Schema.Struct({ kind: Schema.Literal("square"), side: Schema.Finite }),
    ]),
    success: Schema.String,
  });

  const Scores = Action.make("scores", {
    description: "A record's keys are not known in advance",
    access: "write",
    input: Schema.Record(Schema.String, Schema.Finite),
    success: Schema.String,
  });

  const record = <Input>(input: Input) =>
    Effect.andThen(
      Effect.sync(() => values.push(input)),
      () => Effect.succeed("ok"),
    );

  const app = Action.implement(
    [Scalar, Shape, Scores],
    {
      scalar: record,
      shape: record,
      scores: record,
    },
    Action.allowAll,
  );

  await run(ActionCli.command(app, Scalar), ["--input", '"text"']);
  await run(ActionCli.command(app, Shape), ["--input", '{"kind":"square","side":2}']);
  await run(ActionCli.command(app, Scores), ["--input", '{"a":1,"b":2}']);

  // Text that is not JSON is taken as a string: the scalar's plain text, or a shape's error.
  await run(ActionCli.command(app, Scalar), ["--input", "plain"]);

  expect(causeOf(await runExit(ActionCli.command(app, Shape), ["--input", "{"]))).toBeInstanceOf(
    Action.InvalidInput,
  );

  // No field of a union member is a flag of its own.
  expect(
    failure(await runExit(ActionCli.command(app, Shape), ["--kind", "square", "--side", "2"])),
  ).toBeInstanceOf(CliError.ShowHelp);
  // A misspelled key of a union member is refused, not dropped.
  expect(
    causeOf(
      await runExit(ActionCli.command(app, Shape), [
        "--input",
        '{"kind":"square","side":2,"sied":3}',
      ]),
    ),
  ).toBeInstanceOf(Action.InvalidInput);

  // Omitted, the input is `{}`: no shape, so invalid input, but a valid record.
  expect(causeOf(await runExit(ActionCli.command(app, Shape), []))).toBeInstanceOf(
    Action.InvalidInput,
  );
  await run(ActionCli.command(app, Scores), []);

  expect(values).toEqual(["text", { kind: "square", side: 2 }, { a: 1, b: 2 }, "plain", {}]);
});

it("decodes --input only when the command runs, with an asynchronous schema too", async () => {
  let decoded = 0;

  const Delayed = Action.make("delayed", {
    description: "A record decoded asynchronously",
    access: "write",
    input: Schema.Record(Schema.String, Schema.Finite).pipe(
      Schema.decode({
        decode: SchemaGetter.transformEffect((scores: Readonly<Record<string, number>>) =>
          Effect.delay(
            Effect.as(
              Effect.sync(() => void decoded++),
              scores,
            ),
            "1 millis",
          ),
        ),
        encode: SchemaGetter.passthrough(),
      }),
    ),
    success: Schema.Finite,
  });

  const command = ActionCli.command(
    Action.implement(
      Delayed,
      (scores) => Effect.succeed(Object.keys(scores).length),
      Action.allowAll,
    ),
    Delayed,
  );

  expect(decoded).toBe(0);
  expect(await lines(command, ["--input", '{"a":1}'])).toEqual(["1"]);
  expect(await lines(command, [])).toEqual(["0"]);
  expect(decoded).toBe(2);
});

it("keeps custom renderer JSON output and validates success before rendering", async () => {
  let rendered = 0;

  const Rendered = Action.make("rendered", {
    description: "Renders",
    access: "write",
    success: Schema.String,
  });

  const app = Action.implement(
    [Rendered],
    {
      rendered: () => Effect.succeed("value"),
    },
    Action.allowAll,
  );

  const command = ActionCli.command(app, Rendered, {
    render: (value) => `${++rendered}:${value}`,
  });

  expect(await lines(command, ["--json"])).toEqual(['"value"']);
  expect(rendered).toBe(0);

  const invalidRenderer = vi.fn((value: number) => String(value));

  const Invalid = Action.make("invalid", {
    description: "Invalid",
    access: "write",
    success: Schema.Finite,
  });

  const invalid = Action.implement(
    [Invalid],
    {
      invalid: () => Effect.succeed(Infinity),
    },
    Action.allowAll,
  );

  const exit = await runExit(ActionCli.command(invalid, Invalid, { render: invalidRenderer }), []);

  // A success its schema does not encode is a defect, as a server's 500 is, before anything
  // renders it.
  expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true);
  expect(failure(exit)).toBeUndefined();
  expect(invalidRenderer).not.toHaveBeenCalled();
});

it("prints nothing for an action that returns nothing, but prints a declared null", async () => {
  const Reset = Action.make("reset", { description: "Reset", access: "write" });

  const Clear = Action.make("clear", {
    description: "Clear",
    access: "write",
    success: Schema.Null,
  });

  const app = Action.implement(
    [Reset, Clear],
    {
      reset: () => Effect.void,
      clear: () => Effect.succeed(null),
    },
    Action.allowAll,
  );

  expect(await lines(ActionCli.command(app, Reset), [])).toEqual([]);
  expect(await lines(ActionCli.command(app, Clear), [])).toEqual(["null"]);
});

it("keeps an input field's flags apart from the renderer's --json", async () => {
  const inputs: string[] = [];

  const Configured = Action.make("configured", {
    description: "A field whose flag is not the renderer's",
    access: "write",
    input: Schema.Struct({ payloadJson: Schema.String }),
    success: Schema.String,
  });

  const app = Action.implement(
    [Configured],
    {
      configured: ({ payloadJson }) =>
        Effect.andThen(
          Effect.sync(() => inputs.push(payloadJson)),
          () => Effect.succeed(payloadJson),
        ),
    },
    Action.allowAll,
  );

  const command = ActionCli.command(app, Configured, { render: (value) => `rendered ${value}` });

  expect(await lines(command, ["--payload-json", "value", "--json"])).toEqual(['"value"']);
  expect(await lines(command, ["--payload-json", "value"])).toEqual(["rendered value"]);
  expect(inputs).toEqual(["value", "value"]);
});

it("takes flags from a class input's fields, described by their schemas", async () => {
  class Lookup extends Schema.Class<Lookup>("Lookup")({
    userId: Schema.String.annotate({ description: "Whose record to read" }),
    attempts: Schema.Number.annotate({ description: "How many times to try" }),
  }) {}

  const Read = Action.make("readUser", {
    description: "Read a user",
    access: "read",
    input: Lookup,
    success: Schema.String,
  });

  const app = Action.implement(
    Read,
    (lookup) => Effect.succeed(`${lookup.userId} ${lookup.attempts} ${lookup instanceof Lookup}`),
    Action.allowAll,
  );

  const command = ActionCli.command(app, Read);

  expect(await lines(command, ["--user-id", "u1", "--attempts", "2"])).toEqual(['"u1 2 true"']);

  // Encoding drops a transformed field's description; the flag keeps the declared one.
  const help = (await lines(command, ["--help"])).join("\n");
  expect(help).toMatch(/--user-id string\s+Whose record to read/);
  expect(help).toMatch(/--attempts value\s+How many times to try/);
});

it("names a flag without the field's leading underscore, and describes swapped fields by their own schemas", async () => {
  const Tag = Action.make("tag", {
    description: "Tags a record",
    access: "write",
    input: Schema.Struct({
      _id: Schema.String,
      a: Schema.String.annotate({ description: "The first" }),
      b: Schema.String.annotate({ description: "The second" }),
    }).pipe(Schema.encodeKeys({ a: "b", b: "a" })),
    success: Schema.String,
  });

  const command = ActionCli.command(
    Action.implement(
      Tag,
      (input) => Effect.succeed(`${input._id} ${input.a} ${input.b}`),
      Action.allowAll,
    ),
    Tag,
  );

  // A name of underscores alone keeps them, rather than naming nothing.
  const Underscore = Action.make("_", { description: "", access: "read" });

  expect(
    ActionCli.command(
      Action.implement(Underscore, () => Effect.void, Action.allowAll),
      Underscore,
    ).name,
  ).toBe("_");

  // `--b` fills field `a`, its encoded name, and is described as `a`.
  expect(await lines(command, ["--id", "r1", "--b", "first", "--a", "second"])).toEqual([
    '"r1 first second"',
  ]);

  const help = (await lines(command, ["--help"])).join("\n");
  expect(help).toMatch(/--id string/);
  expect(help).toMatch(/--b string\s+The first/);
  expect(help).toMatch(/--a string\s+The second/);
});

it("takes an optional field's plain value, and leaves it out when its flag is omitted", async () => {
  const Search = Action.make("search", {
    description: "Searches",
    access: "read",
    input: {
      query: Schema.optional(Schema.String),
      limit: Schema.optional(Schema.Number.annotate({ description: "How many to return" })),
      exact: Schema.optional(Schema.Boolean).annotate({ description: "Match whole words" }),
    },
    success: Schema.String,
  });

  const command = ActionCli.command(
    Action.implement(Search, (input) => Effect.succeed(JSON.stringify(input)), Action.allowAll),
    Search,
  );

  expect(await lines(command, ["--query", "x", "--limit", "3", "--exact"])).toEqual([
    JSON.stringify(JSON.stringify({ query: "x", limit: 3, exact: true })),
  ]);
  expect(await lines(command, [])).toEqual([JSON.stringify("{}")]);

  // A struct field keeps its declared description through encoding, as a class field does,
  // whether the optional field or its value carries it.
  const help = (await lines(command, ["--help"])).join("\n");
  expect(help).toMatch(/--query string/);
  expect(help).toMatch(/--limit value\s+How many to return/);
  expect(help).toMatch(/--exact\s+Match whole words/);
});

it("keeps the null an optional field declares itself, so the flag can send it", async () => {
  const Note = Action.make("note", {
    description: "Sets or clears a note",
    access: "write",
    input: { note: Schema.optionalKey(Schema.NullOr(Schema.String)) },
    success: Schema.String,
  });

  const command = ActionCli.command(
    Action.implement(Note, (input) => Effect.succeed(JSON.stringify(input)), Action.allowAll),
    Note,
  );

  expect(await lines(command, ["--note", "null"])).toEqual([
    JSON.stringify(JSON.stringify({ note: null })),
  ]);
  expect(await lines(command, ["--note", '"x"'])).toEqual([
    JSON.stringify(JSON.stringify({ note: "x" })),
  ]);
  expect(await lines(command, [])).toEqual([JSON.stringify("{}")]);
});

it("keeps the null an optional field's codec encodes, under its encoded name too", async () => {
  const note = Schema.OptionFromNullOr(Schema.String);

  const noteOf = async (
    input: Schema.Codec<{ readonly note?: Option.Option<string> | undefined }, unknown>,
    flag: string,
  ) => {
    const Note = Action.make("note", {
      description: "Sets or clears a note",
      access: "write",
      input,
      success: Schema.String,
    });

    const command = ActionCli.command(
      Action.implement(
        Note,
        (value) =>
          Effect.succeed(
            value.note === undefined
              ? "absent"
              : Option.match(value.note, {
                  onNone: () => "none",
                  onSome: (text) => `some ${text}`,
                }),
          ),
        Action.allowAll,
      ),
      Note,
    );

    return [
      ...(await lines(command, [flag, "null"])),
      ...(await lines(command, [flag, "x"])),
      ...(await lines(command, [])),
    ];
  };

  const expected = ["none", "some x", "absent"].map((line) => JSON.stringify(line));

  expect(await noteOf(Schema.Struct({ note: Schema.optionalKey(note) }), "--note")).toEqual(
    expected,
  );
  expect(await noteOf(Schema.Struct({ note: Schema.optional(note) }), "--note")).toEqual(expected);
  expect(
    await noteOf(
      Schema.Struct({ note: Schema.optionalKey(note) }).pipe(
        Schema.encodeKeys({ note: "wireNote" }),
      ),
      "--wire-note",
    ),
  ).toEqual(expected);
});

it("takes a number, a non-finite number or a string beside it as JSON or plain text", async () => {
  const Page = Action.make("page", {
    description: "Reads a page",
    access: "read",
    input: {
      limit: Schema.Union([Schema.Finite, Schema.Literal("auto")]),
      scale: Schema.optionalKey(Schema.Number),
      level: Schema.optionalKey(Schema.Enum({ Low: 1, High: 2 })),
    },
    success: Schema.String,
  });

  const command = ActionCli.command(
    Action.implement(
      Page,
      ({ limit, scale, level }) => Effect.succeed([limit, scale, level].map(String).join(" ")),
      Action.allowAll,
    ),
    Page,
  );

  expect(await lines(command, ["--limit", "3"])).toEqual(['"3 undefined undefined"']);
  expect(await lines(command, ["--limit", "auto"])).toEqual(['"auto undefined undefined"']);
  expect(await lines(command, ["--limit", '"auto"'])).toEqual(['"auto undefined undefined"']);
  // `Schema.Number` encodes a non-finite value as text, which its flag takes as it is.
  expect(await lines(command, ["--limit", "1", "--scale", "Infinity", "--level", "2"])).toEqual([
    '"1 Infinity 2"',
  ]);
  expect((await lines(command, ["--help"])).join("\n")).toMatch(/--limit value/);
});

it("takes JSON only as a value the field accepts, and nested literal unions as one choice", async () => {
  const Tune = Action.make("tune", {
    description: "Tunes a setting",
    access: "write",
    input: {
      mode: Schema.Union([Schema.Literals(["true", "false"]), Schema.Literal("auto")]),
      label: Schema.optionalKey(Schema.Union([Schema.Literal("auto"), Schema.String])),
      extra: Schema.optionalKey(Schema.Json),
    },
    success: Schema.String,
  });

  const command = ActionCli.command(
    Action.implement(
      Tune,
      ({ mode, label, extra }) => Effect.succeed(JSON.stringify([mode, label, extra])),
      Action.allowAll,
    ),
    Tune,
  );

  // `true` is JSON, but neither field accepts a boolean: each takes the text.
  expect(await lines(command, ["--mode", "true", "--label", "true"])).toEqual([
    JSON.stringify(JSON.stringify(["true", "true", undefined])),
  ]);
  // A field that accepts any JSON still takes it as JSON.
  expect(await lines(command, ["--mode", "auto", "--extra", '{"a":[1]}'])).toEqual([
    JSON.stringify(JSON.stringify(["auto", undefined, { a: [1] }])),
  ]);
  expect(failure(await runExit(command, ["--mode", "maybe"]))).toBeInstanceOf(CliError.ShowHelp);
});

it("hands the action's schema all of the JSON, keys a first union member lacks included", async () => {
  // The first member's encoding accepts `{ a: "bad", b: "keep" }` without `b`; only the second
  // decodes it.
  const Pair = Schema.Union([
    Schema.Struct({ a: Schema.FiniteFromString }),
    Schema.Struct({ a: Schema.String, b: Schema.String }),
  ]);

  const Whole = Action.make("whole", {
    description: "Takes a pair",
    access: "read",
    input: Pair,
    success: Schema.String,
  });

  const Nested = Action.make("nested", {
    description: "Takes a pair as a field",
    access: "read",
    input: { pair: Pair },
    success: Schema.String,
  });

  const app = Action.implement(
    [Whole, Nested],
    {
      whole: (input) => Effect.succeed(JSON.stringify(input)),
      nested: ({ pair }) => Effect.succeed(JSON.stringify(pair)),
    },
    Action.allowAll,
  );

  const pair = '{"a":"bad","b":"keep"}';
  const printed = [JSON.stringify(pair)];

  expect(await lines(ActionCli.command(app, Whole), ["--input", pair])).toEqual(printed);
  expect(await lines(ActionCli.command(app, Nested), ["--pair", pair])).toEqual(printed);
});

it("lets a field shadow a global flag, and refuses a clash within a command when it is built", async () => {
  const Settings = Action.make("settings", {
    description: "Has fields named like global flags and like the renderer's flag",
    access: "read",
    input: { help: Schema.String, logLevel: Schema.String, json: Schema.String },
    success: Schema.String,
  });

  const app = Action.implement(
    Settings,
    ({ help, logLevel, json }) => Effect.succeed(`${help} ${logLevel} ${json}`),
    Action.allowAll,
  );

  const args = ["--help", "a", "--log-level", "b", "--json", "c"];

  // A field's flag wins over the global flag of the same name.
  expect(await lines(ActionCli.command(app, Settings), args)).toEqual(['"a b c"']);

  // Beside a renderer's own `--json`, the command is refused before it ever runs.
  expect(() => ActionCli.command(app, Settings, { render: String })).toThrow(
    "Duplicate flag: --json, claimed by field json and render's --json",
  );

  // So are two fields of one kebab-case name, in a command or an aggregate.
  const Twice = Action.make("twice", {
    description: "Names one field twice",
    access: "read",
    input: { userId: Schema.String, user_id: Schema.String },
    success: Schema.String,
  });

  const twice = Action.implement(Twice, () => Effect.succeed(""), Action.allowAll);
  const clash = "Duplicate flag: --user-id, claimed by field userId and field user_id";

  expect(() => ActionCli.command(twice, Twice)).toThrow(clash);
  expect(() => ActionCli.make(twice, { name: "tool" })).toThrow(clash);
});

it("runs any action locally, scopes every invocation, and exposes aggregate subcommands", async () => {
  let acquired = 0;
  let released = 0;
  const inputs: string[] = [];

  // Bound to no HTTP or MCP surface: the CLI still runs it.
  const Local = Action.make("local", {
    description: "Runs locally",
    access: "write",
    input: Schema.Struct({ value: Schema.String }),
    success: Schema.String,
  });

  const Other = Action.make("other", {
    description: "Another action",
    access: "write",
    success: Schema.String,
  });

  const app = Action.implement(
    [Local, Other],
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
    Action.allowAll,
  );

  await run(ActionCli.command(app, Local), ["--value", "direct"]);
  await run(ActionCli.make(app, { name: "locals" }), ["local", "--value", "group"]);

  expect(inputs).toEqual(["direct", "group"]);
  expect(acquired).toBe(2);
  expect(released).toBe(2);
});

it("releases a local call's own resources, the hook's included, before its builder's", async () => {
  const log: string[] = [];

  const Scoped = Action.make("scoped", {
    description: "Opens a resource of its own",
    access: "write",
    success: Schema.String,
  });

  const app = Action.implement(
    Scoped,
    Effect.acquireRelease(
      Effect.sync(() => {
        log.push("builder acquire");

        return () =>
          Effect.acquireRelease(
            Effect.sync(() => {
              log.push("handler acquire");

              return "done";
            }),
            () => Effect.sync(() => log.push("handler release")),
          );
      }),
      () => Effect.sync(() => log.push("builder release")),
    ),
    () =>
      Effect.asVoid(
        Effect.acquireRelease(
          Effect.sync(() => log.push("hook acquire")),
          () => Effect.sync(() => log.push("hook release")),
        ),
      ),
  );

  await run(ActionCli.command(app, Scoped), []);

  expect(log).toEqual([
    "builder acquire",
    "hook acquire",
    "handler acquire",
    "handler release",
    "hook release",
    "builder release",
  ]);
});

it("builds a local command's implementation per invocation even where the host built it", async () => {
  let acquired = 0;
  let released = 0;

  const Counted = Action.make("counted", {
    description: "Counts builds",
    access: "write",
    success: Schema.String,
  });

  const app = Action.implement(
    Counted,
    Effect.acquireRelease(
      Effect.sync(() => {
        acquired++;

        return () => Effect.succeed("done");
      }),
      () =>
        Effect.sync(() => {
          released++;
        }),
    ),
    Action.allowAll,
  );

  const inside = await Effect.gen(function* () {
    yield* exec(ActionCli.command(app, Counted), []);
    yield* exec(ActionCli.command(app, Counted), []);

    return { acquired, released };
  }).pipe(Effect.provide(ActionToolkit.make(app).layer), Effect.runPromise);

  // The host's own build, and one per invocation, each released after its call.
  expect(inside).toEqual({ acquired: 3, released: 2 });
  expect(released).toBe(3);
});

it("builds a built hook per invocation, as the builder, and runs it with the caller's services", async () => {
  class Caller extends Context.Service<Caller, string>()("cli-test/Caller") {}

  const log: Array<string> = [];

  const Guarded = Action.make("guarded", {
    description: "Behind a built hook",
    access: "write",
    success: Schema.String,
  });

  const app = Action.implement(
    Guarded,
    () => Effect.succeed("done"),
    Effect.acquireRelease(
      Effect.sync(() => {
        log.push("hook built");

        return () =>
          Effect.flatMap(Caller, (caller) =>
            caller === "alice" ? Effect.void : Effect.fail(new Action.Forbidden()),
          );
      }),
      () => Effect.sync(() => log.push("hook released")),
    ),
  );

  // No remote caller: the host provides the one the hook reads.
  const as = (caller: string) =>
    exec(Command.provideSync(ActionCli.command(app, Guarded), Caller, caller), []);

  await Effect.runPromise(as("alice"));

  expect(causeOf(await Effect.runPromiseExit(as("bob")))).toBeInstanceOf(Action.Forbidden);
  expect(log).toEqual(["hook built", "hook released", "hook built", "hook released"]);
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

  const app = Action.implement(
    [Plain, Pretty],
    {
      plain: () => Effect.succeed("plain"),
      pretty: () => Effect.succeed("pretty"),
    },
    Action.allowAll,
  );

  const pretty = ActionCli.command(app, Pretty, { render: (value) => `rendered ${value}` });
  expect(await lines(pretty, [])).toEqual(["rendered pretty"]);
  expect(await lines(pretty, ["--json"])).toEqual(['"pretty"']);
  // Without a renderer the output is JSON already, and the flag does not exist:
  // the native parser treats it as unknown and shows help.
  expect(await lines(ActionCli.command(app, Plain), [])).toEqual(['"plain"']);
  expect(failure(await runExit(ActionCli.command(app, Plain), ["--json"]))).toBeInstanceOf(
    CliError.ShowHelp,
  );

  // A regular flag: a host that declares `--json` itself, globally or on a
  // parent, still composes; the projected command keeps its own.
  const HostJson = GlobalFlag.Setting("host-json")({
    flag: Flag.Boolean("json").pipe(Flag.withDefault(false)),
  });

  const hosted = Command.make("host", { json: Flag.Boolean("json") }).pipe(
    Command.withSubcommands([pretty, ActionCli.make(app, { name: "output" })]),
    Command.withGlobalFlags([HostJson]),
  );

  expect(await lines(hosted, ["pretty", "--json"])).toEqual(['"pretty"']);
  expect(await lines(hosted, ["output", "plain"])).toEqual(['"plain"']);
});

it("selects a command's implementation by contract identity, not by name", async () => {
  const First = Action.make("same", {
    description: "The first contract named same",
    access: "read",
    success: Schema.String,
  });

  const Second = Action.make("same", {
    description: "Another contract with the same name",
    access: "read",
    success: Schema.String,
  });

  const first = Action.implement(First, () => Effect.succeed("first"), Action.allowAll);
  const second = Action.implement(Second, () => Effect.succeed("second"), Action.allowAll);

  expect(await lines(ActionCli.command([first], First), [])).toEqual(['"first"']);
  expect(await lines(ActionCli.command([second], Second), [])).toEqual(['"second"']);

  // A contract of the same name is not the implemented one.
  expect(() => ActionCli.command([first], Second)).toThrow(
    'Action "same" has no implementation here',
  );

  const Missing = Action.make("missing", {
    description: "Not implemented here",
    access: "read",
    success: Schema.String,
  });

  expect(() =>
    // @ts-expect-error -- `Missing` is not the action of any implementation passed.
    ActionCli.command(first, Missing),
  ).toThrow('Action "missing" has no implementation here');
});

it("aggregates implementations under one named command and refuses duplicate command names", async () => {
  const One = Action.make("one", { description: "One", access: "read", success: Schema.String });
  const Two = Action.make("two", { description: "Two", access: "read", success: Schema.String });

  const one = Action.implement(One, () => Effect.succeed("one"), Action.allowAll);
  const two = Action.implement(Two, () => Effect.succeed("two"), Action.allowAll);

  const tool = ActionCli.make([one, two], { name: "tool" });
  expect(tool.name).toBe("tool");

  expect(await lines(tool, ["two"])).toEqual(['"two"']);

  const Again = Action.make("one", {
    description: "Again",
    access: "read",
    success: Schema.String,
  });

  const again = Action.implement(Again, () => Effect.succeed("again"), Action.allowAll);

  expect(() => ActionCli.make([one, again], { name: "tool" })).toThrow("Duplicate command: one");

  // One action implemented twice is refused too, rather than the first one run.
  const guarded = Action.implement(
    One,
    () => Effect.succeed("guarded"),
    () => Effect.fail(new Action.Forbidden()),
  );

  expect(() => ActionCli.command([one, guarded], One)).toThrow(
    'Action "one" is implemented twice here',
  );

  // A single command checks only its own action: other names may repeat.
  expect(await lines(ActionCli.command([one, two, again], Two), [])).toEqual(['"two"']);
});

it("names commands and flags in kebab case, unless a name is given", async () => {
  const users: string[] = [];

  const GetUser = Action.make("getUser", {
    description: "Reads a user",
    access: "read",
    input: { userId: Schema.String },
    success: Schema.String,
  });

  const app = Action.implement(
    GetUser,
    ({ userId }) =>
      Effect.andThen(
        Effect.sync(() => users.push(userId)),
        () => Effect.succeed(userId),
      ),
    Action.allowAll,
  );

  const command = ActionCli.command(app, GetUser);
  expect(command.name).toBe("get-user");
  expect(ActionCli.command(app, GetUser, { name: "whois" }).name).toBe("whois");

  // An acronym is one word.
  const GetHTTPUser = Action.make("getHTTPUser", {
    description: "Reads a user over HTTP",
    access: "read",
    success: Schema.String,
  });

  const http = Action.implement(GetHTTPUser, () => Effect.succeed("http"), Action.allowAll);
  expect(ActionCli.command(http, GetHTTPUser).name).toBe("get-http-user");

  await run(command, ["--user-id", "alice"]);
  await run(ActionCli.make(app, { name: "users" }), ["get-user", "--user-id", "bob"]);

  // The action's own name is not a subcommand.
  expect(
    failure(await runExit(ActionCli.make(app, { name: "users" }), ["getUser", "--user-id", "x"])),
  ).toBeInstanceOf(CliError.ShowHelp);

  expect(users).toEqual(["alice", "bob"]);

  // Two distinct action names can share a kebab-case command name.
  const Snake = Action.make("get_user", {
    description: "Another spelling",
    access: "read",
    success: Schema.String,
  });

  const snake = Action.implement(Snake, () => Effect.succeed("snake"), Action.allowAll);

  expect(() => ActionCli.make([app, snake], { name: "users" })).toThrow(
    "Duplicate command: get-user, claimed by action getUser and action get_user",
  );
});

it("runs the implementation's before hook first, and its refusal is the cause of the command's failure", async () => {
  const seen: string[] = [];
  let calls = 0;

  const Read = Action.make("read", { description: "Read", access: "read", success: Schema.String });

  const Write = Action.make("write", {
    description: "Write",
    access: "write",
    success: Schema.String,
  });

  const before = (action: Action.Any) =>
    Effect.andThen(
      Effect.sync(() => seen.push(action.name)),
      () =>
        action.access === "read"
          ? Effect.void
          : Effect.fail(new Action.Forbidden({ message: "Requires users:write." })),
    );

  const app = Action.implement(
    [Read, Write],
    {
      read: () => Effect.sync(() => `read ${++calls}`),
      write: () => Effect.sync(() => `write ${++calls}`),
    },
    before,
  );

  await run(ActionCli.command(app, Read), []);

  const refused = causeOf(await runExit(ActionCli.command(app, Write), []));
  expect(refused).toBeInstanceOf(Action.Forbidden);
  expect(refused).toEqual(new Action.Forbidden({ message: "Requires users:write." }));

  const aggregate = ActionCli.make(app, { name: "tool" });
  await run(aggregate, ["read"]);
  expect(causeOf(await runExit(aggregate, ["write"]))).toBeInstanceOf(Action.Forbidden);

  // Refused, the handler never runs.
  expect(seen).toEqual(["read", "write", "read", "write"]);
  expect(calls).toBe(2);
});

it("acquires only the builder of the selected command's implementation", async () => {
  const builds: string[] = [];

  const Built = Action.make("built", {
    description: "Built",
    access: "read",
    success: Schema.String,
  });

  const Idle = Action.make("idle", { description: "Idle", access: "read", success: Schema.String });

  const built = Action.implement(
    Built,
    Effect.sync(() => {
      builds.push("built");

      return () => Effect.succeed("built");
    }),
    Action.allowAll,
  );

  const idle = Action.implement(
    Idle,
    Effect.sync(() => {
      builds.push("idle");

      return () => Effect.succeed("idle");
    }),
    Action.allowAll,
  );

  await run(ActionCli.command([built, idle], Built), []);
  await run(ActionCli.make([built, idle], { name: "tool" }), ["built"]);

  expect(builds).toEqual(["built", "built"]);
});

it("dies when the command runs if its builder's record lacks a handler, whichever runs", async () => {
  const Present = Action.make("present", {
    description: "Has a handler",
    access: "read",
    success: Schema.String,
  });

  const Absent = Action.make("absent", {
    description: "Its handler is missing at runtime",
    access: "read",
    success: Schema.String,
  });

  // An inherited method satisfies the types, but only own properties are handlers.
  class Inherited {
    absent() {
      return Effect.succeed("inherited");
    }
  }

  class Handlers extends Inherited {
    readonly present = () => Effect.succeed("present");
  }

  const apps = Action.implement(
    [Present, Absent],
    Effect.sync(() => new Handlers()),
    Action.allowAll,
  );

  // Building the command checks nothing; running it builds and checks the whole record.
  for (const action of [Absent, Present]) {
    const exit = await runExit(ActionCli.command(apps, action), []);

    expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true);

    if (Exit.isFailure(exit)) {
      expect(Cause.pretty(exit.cause)).toContain("Missing handlers: absent");
    }
  }
});

it("takes the listed fields as positional arguments, in their order, parsed as their flags", async () => {
  const inputs: unknown[] = [];

  const Copy = Action.make("copy", {
    description: "Copy a file",
    access: "write",
    input: {
      from: Schema.String,
      to: Schema.String,
      count: Schema.Finite,
      mode: Schema.Literals(["fast", "safe"]),
      verbose: Schema.Boolean,
      note: Schema.optional(Schema.String),
      dryRun: Schema.Boolean,
    },
    success: Schema.String,
  });

  const app = Action.implement(
    Copy,
    (input) =>
      Effect.andThen(
        Effect.sync(() => inputs.push(input)),
        () => Effect.succeed("copied"),
      ),
    Action.allowAll,
  );

  const copy = ActionCli.command(app, Copy, {
    positional: ["to", "from", "count", "mode", "verbose", "note"],
  });

  // Read in the listed order, not the input's; a field not listed keeps its flag.
  await run(copy, ["b", "a", "3", "safe", "true"]);
  await run(copy, ["--dry-run", "b", "a", "3", "fast", "false", "hi"]);

  expect(inputs).toEqual([
    { to: "b", from: "a", count: 3, mode: "safe", verbose: true, dryRun: false },
    { to: "b", from: "a", count: 3, mode: "fast", verbose: false, note: "hi", dryRun: true },
  ]);

  // A positional field has no flag, and a missing or invalid argument shows help.
  expect(failure(await runExit(copy, ["--from", "a", "b", "3", "safe", "true"]))).toBeInstanceOf(
    CliError.ShowHelp,
  );
  expect(failure(await runExit(copy, ["b", "a", "3"]))).toBeInstanceOf(CliError.ShowHelp);
  expect(failure(await runExit(copy, ["b", "a", "3", "slow", "true"]))).toBeInstanceOf(
    CliError.ShowHelp,
  );
  expect(inputs).toHaveLength(2);
});

it("refuses positional arguments a parser could not read back", () => {
  const Pair = Action.make("pair", {
    description: "A required and an optional field",
    access: "write",
    input: { first: Schema.String, second: Schema.optional(Schema.String) },
  });

  const Scalar = Action.make("scalar", {
    description: "Not a struct",
    access: "write",
    input: Schema.String,
  });

  const pair = Action.implement(Pair, () => Effect.void, Action.allowAll);
  const scalar = Action.implement(Scalar, () => Effect.void, Action.allowAll);

  expect(() => ActionCli.command(pair, Pair, { positional: ["first", "first"] })).toThrow(
    "Duplicate positional argument: first",
  );
  expect(() => ActionCli.command(pair, Pair, { positional: ["second", "first"] })).toThrow(
    "Required positional argument after an optional one: first",
  );
  // SAFETY: a plain-JavaScript caller, whom the types do not stop.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Untyped caller fixture.
  expect(() => ActionCli.command(pair, Pair, { positional: ["third"] as never })).toThrow(
    "Not an input field: third",
  );
  // SAFETY: the same untyped caller, for an input without named fields.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Untyped caller fixture.
  expect(() => ActionCli.command(scalar, Scalar, { positional: ["length"] as never })).toThrow(
    "Positional arguments need named input fields: length",
  );
});

it("gives a subcommand of an aggregate the options command takes, by action name", async () => {
  const Read = Action.make("readFile", {
    description: "Read a file",
    access: "read",
    input: { path: Schema.String, lines: Schema.optional(Schema.Finite) },
    success: Schema.String,
  });

  const Size = Action.make("size", {
    description: "A file's size",
    access: "read",
    input: { path: Schema.String },
    success: Schema.Finite,
  });

  const app = Action.implement(
    [Read, Size],
    {
      readFile: ({ path, lines }) => Effect.succeed(`${path}:${lines ?? "all"}`),
      size: () => Effect.succeed(3),
    },
    Action.allowAll,
  );

  const command = ActionCli.make(app, {
    name: "files",
    commands: {
      readFile: { name: "cat", positional: ["path"], render: (text) => text.toUpperCase() },
    },
  });

  expect(await lines(command, ["cat", "a.txt", "--lines", "2"])).toEqual(["A.TXT:2"]);
  expect(await lines(command, ["cat", "a.txt", "--json"])).toEqual(['"a.txt:all"']);
  // A subcommand without options keeps its defaults.
  expect(await lines(command, ["size", "--path", "a.txt"])).toEqual(["3"]);

  // A key no action names is refused, as plain JavaScript may pass it, and so is a name
  // another subcommand has.
  const stale = Object.fromEntries([["read", { name: "read" }]]);

  expect(() => ActionCli.make(app, { name: "files", commands: stale })).toThrow(
    "Unknown commands: read",
  );
  expect(() =>
    ActionCli.make(app, { name: "files", commands: { readFile: { name: "size" } } }),
  ).toThrow("Duplicate command: size");
});

it("fails with Effect CLI's UserError, which the runner prints on stderr as the JSON HTTP sends", async () => {
  class Gone extends Schema.TaggedError<Gone>()("Gone", { id: Schema.String }) {
    override readonly [Runtime.errorExitCode] = 3;
  }

  class Missing extends Schema.TaggedError<Missing>()(
    "Missing",
    { id: Schema.String },
    { httpApiStatus: 404 },
  ) {}

  // Fields whose JSON is not their value: HTTP sends a bigint as a string, an Option tagged.
  class Over extends Schema.TaggedError<Over>()("Over", {
    limit: Schema.BigInt,
    hint: Schema.Option(Schema.String),
  }) {}

  // Encoded by an Effect that completes later, as a codec may be.
  class Busy extends Schema.TaggedError<Busy>()("Busy", {
    reason: Schema.String.pipe(
      Schema.decodeTo(
        Schema.String,
        SchemaTransformation.transformEffect({
          decode: (reason) => Effect.succeed(reason),
          encode: (reason) => Effect.as(Effect.sleep("1 millis"), reason),
        }),
      ),
    ),
  }) {}

  const Read = Action.make("read", {
    description: "Reads a record",
    access: "read",
    input: { id: Schema.String.check(Schema.isMinLength(1)) },
    success: Schema.String,
    errors: [Gone, Missing, Over, Busy],
  });

  const over = new Over({ limit: 10n, hint: Option.some("lower it") });

  const Write = Action.make("write", { description: "Writes", access: "write" });

  const app = Action.implement(
    [Read, Write],
    {
      read: ({ id }) =>
        Match.value(id).pipe(
          Match.when("gone", () => Effect.fail(new Gone({ id }))),
          Match.when("over", () => Effect.fail(over)),
          Match.when("busy", () => Effect.fail(new Busy({ reason: "full" }))),
          Match.orElse(() => Effect.fail(new Missing({ id }))),
        ),
      write: () => Effect.void,
    },
    (action) =>
      action.access === "read"
        ? Effect.void
        : Effect.fail(new Action.Forbidden({ message: "Requires write.", scopes: ["write"] })),
  );

  const cli = ActionCli.make(app, { name: "records" });
  const web = serve(ActionHttp.layer(ActionHttp.make([Read, Write]), app));

  const cases = [
    {
      args: ["read", "--id", "gone"],
      body: { id: "gone" },
      cause: new Gone({ id: "gone" }),
      code: 3,
    },
    { args: ["read", "--id", "x"], body: { id: "x" }, cause: new Missing({ id: "x" }), code: 1 },
    { args: ["read", "--id", "over"], body: { id: "over" }, cause: over, code: 1 },
    {
      args: ["read", "--id", "busy"],
      body: { id: "busy" },
      cause: new Busy({ reason: "full" }),
      code: 1,
    },
    {
      args: ["write"],
      body: {},
      cause: new Action.Forbidden({ message: "Requires write.", scopes: ["write"] }),
      code: 1,
    },
  ];

  for (const { args, body, cause, code } of cases) {
    const [exit, stdout, stderr] = await Command.runWith(cli, { version: "0" })(args).pipe(
      printed,
      Effect.provide(cliServices),
      Effect.runPromise,
    );

    const [name = ""] = args;
    const sent = await (await web.handler(post(`/api/${name}`, body))).text();

    expect(causeOf(exit)).toEqual(cause);
    // Nothing on stdout, and on stderr the body HTTP answers with, once.
    expect(stdout).toEqual([]);
    expect(stderr).toEqual([expect.stringContaining(sent)]);
    expect(sent).toContain(`"_tag":"${cause._tag}"`);

    // `runMain` exits with the cause's own code, and does not print it again.
    const reported = Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined;

    expect(Runtime.getErrorExitCode(reported)).toBe(code);
    expect(Runtime.getErrorReported(reported)).toBe(false);
  }

  // Input that does not decode is the `InvalidInput` HTTP answers, before the hook runs.
  const [invalid, , stderr] = await Command.runWith(cli, { version: "0" })([
    "read",
    "--id",
    "",
  ]).pipe(printed, Effect.provide(cliServices), Effect.runPromise);

  const sent = await (await web.handler(post("/api/read", { id: "" }))).text();

  expect(causeOf(invalid)).toBeInstanceOf(Action.InvalidInput);
  expect(sent).toContain('"_tag":"InvalidInput"');
  expect(stderr).toEqual([expect.stringContaining(sent)]);

  // With `renderErrors: false` the runner prints nothing and leaves the failure unmarked,
  // so `runMain` still reports it: the library never marks a failure reported itself.
  const [unrendered, quietOut, quietErr] = await Command.runWith(cli, {
    version: "0",
    renderErrors: false,
  })(["read", "--id", "x"]).pipe(printed, Effect.provide(cliServices), Effect.runPromise);

  expect(causeOf(unrendered)).toEqual(new Missing({ id: "x" }));
  expect([quietOut, quietErr]).toEqual([[], []]);
  expect(
    Runtime.getErrorReported(
      Exit.isFailure(unrendered) ? Cause.squash(unrendered.cause) : undefined,
    ),
  ).toBe(true);
});

it("prints a failure as the host's formatError writes it, on a copy of Effect's formatter", async () => {
  class Gone extends Schema.TaggedError<Gone>()("Gone", { id: Schema.String }) {}

  const Remove = Action.make("remove", { description: "Removes", access: "write", errors: [Gone] });
  const app = Action.implement(Remove, () => Effect.fail(new Gone({ id: "x" })), Action.allowAll);
  const formatError = (error: CliError.CliError) => `refused: ${error.message}`;

  // The form ActionCli.md gives, which leaves the default formatter as it is.
  const [exit, stdout, stderr] = await Command.runWith(ActionCli.command(app, Remove), {
    version: "0",
  })([]).pipe(
    printed,
    Effect.provide(
      CliOutput.layer(Object.assign({}, CliOutput.defaultFormatter(), { formatError })),
    ),
    Effect.provide(cliServices),
    Effect.runPromise,
  );

  expect(causeOf(exit)).toEqual(new Gone({ id: "x" }));
  expect([stdout, stderr]).toEqual([[], ['refused: {"_tag":"Gone","id":"x"}']]);
});

it("describes a failure no schema encodes by its tag or an error's name, its message and causes, never its fields", async () => {
  class Unreachable extends Data.TaggedError("Unreachable")<{
    readonly url: string;
    readonly cause: Error;
  }> {}

  // Plain tagged objects, as code outside Effect may fail or throw with.
  const DbDown = Schema.TaggedStruct("DbDown", { url: Schema.String });
  const UserExists = Schema.TaggedStruct("UserExists", { name: Schema.String });

  const Status = Action.make("status", { description: "Status", access: "read" });
  const url = "postgres://admin:hunter2@db";

  // A cause leading back to a failure already described ends the description.
  const looping = new Error("db unreachable");

  looping.cause = looping;

  // A builder's failure, and what it prints: an error, or plain objects, whose fields no
  // schema says are safe to show, their `name` among them.
  const failures = [
    [
      new Unreachable({ url, cause: new Error("connect ECONNREFUSED 10.0.0.1:5432") }),
      "Unreachable: Error: connect ECONNREFUSED 10.0.0.1:5432",
    ],
    [DbDown.make({ url }), "DbDown"],
    [UserExists.make({ name: url }), "UserExists"],
    [{ name: url, message: "db unreachable" }, "Error: db unreachable"],
    [new Error("db unreachable", { cause: { url } }), "Error: db unreachable: Error"],
    [looping, "Error: db unreachable"],
  ] as const;

  for (const [failure, description] of failures) {
    const app = Action.implement(
      Status,
      Effect.as(Effect.fail(failure), () => Effect.void),
      Action.allowAll,
    );

    const [exit, stdout, stderr] = await Command.runWith(ActionCli.command(app, Status), {
      version: "0",
    })([]).pipe(printed, Effect.provide(cliServices), Effect.runPromise);

    expect(causeOf(exit)).toBe(failure);
    expect(stdout).toEqual([]);
    // The description is the last line, beneath Effect's own heading.
    expect(stderr.map((text) => String(text).trim().split("\n").at(-1)?.trim())).toEqual([
      description,
    ]);
    expect(stderr.join("\n")).not.toContain("hunter2");
  }
});

it("writes the logs and console output of what a command runs to stderr, and only its result to stdout", async () => {
  const Noisy = Action.make("noisy", {
    description: "Logs",
    access: "read",
    success: Schema.String,
  });

  const noise = (source: string) =>
    Effect.andThen(Effect.log(`${source} log`), Console.log(`${source} console`));

  const app = Action.implement(
    Noisy,
    Effect.as(noise("builder"), () => Effect.as(noise("handler"), "quiet")),
    () => noise("hook"),
  );

  const command = ActionCli.command(app, Noisy);

  // The default logger, and a console logger, which writes through `Console.log`.
  for (const logger of [Layer.empty, Logger.layer([Logger.consoleJson])]) {
    const [exit, stdout, stderr] = await Command.runWith(command, { version: "0" })([]).pipe(
      printed,
      Effect.provide(logger),
      Effect.provide(cliServices),
      Effect.runPromise,
    );

    const written = stderr.map(String).join("\n");

    expect(Exit.isSuccess(exit)).toBe(true);
    expect(stdout).toEqual(['"quiet"']);

    for (const source of ["builder", "hook", "handler"]) {
      expect(written).toContain(`${source} log`);
      expect(written).toContain(`${source} console`);
    }
  }

  // Its codecs too: the input's as it decodes, the success's and a failure's as they encode.
  const logged = (source: string) =>
    Schema.String.pipe(
      Schema.decodeTo(
        Schema.String,
        SchemaTransformation.transformEffect({
          decode: (value) => Effect.as(noise(`${source} decode`), value),
          encode: (value) => Effect.as(noise(`${source} encode`), value),
        }),
      ),
    );

  class Refused extends Schema.TaggedError<Refused>()("Refused", { reason: logged("failure") }) {}

  const Coded = Action.make("coded", {
    description: "Logs in its codecs",
    access: "read",
    input: { word: logged("input") },
    success: logged("success"),
    errors: [Refused],
  });

  const coded = ActionCli.command(
    Action.implement(
      Coded,
      ({ word }) =>
        word === "no" ? Effect.fail(new Refused({ reason: word })) : Effect.succeed(word),
      Action.allowAll,
    ),
    Coded,
  );

  for (const [word, sources, result] of [
    ["yes", ["input decode", "success encode"], ['"yes"']],
    ["no", ["input decode", "failure encode"], []],
  ] as const) {
    const [, stdout, stderr] = await Command.runWith(coded, { version: "0" })([
      "--word",
      word,
    ]).pipe(printed, Effect.provide(cliServices), Effect.runPromise);

    const written = stderr.map(String).join("\n");

    expect(stdout).toEqual(result);

    for (const source of sources) {
      expect(written).toContain(`${source} log`);
      expect(written).toContain(`${source} console`);
    }
  }

  // A remote command's client too, configured on the command, which logs as it sends.
  const Http = ActionHttp.make([Noisy]);

  const web = serve(
    ActionHttp.layer(
      Http,
      Action.implement(Noisy, () => Effect.succeed("quiet"), Action.allowAll),
    ),
  );

  const remote = ActionCli.command(Http, Noisy).pipe(
    Command.provideEffect(
      HttpClient.HttpClient,
      Effect.map(
        HttpClient.HttpClient,
        HttpClient.tapRequest(() => noise("client")),
      ),
    ),
  );

  const [exit, stdout, stderr] = await Command.runWith(remote, { version: "0" })([]).pipe(
    printed,
    Effect.provide(clientLayer(web.handler)),
    Effect.provide(cliServices),
    Effect.runPromise,
  );

  const written = stderr.map(String).join("\n");

  expect(Exit.isSuccess(exit)).toBe(true);
  expect(stdout).toEqual(['"quiet"']);
  expect(written).toContain("client log");
  expect(written).toContain("client console");
});

it("builds what a command is provided when an action runs, never for help or a parse error", async () => {
  class Database extends Context.Service<Database, string>()("cli-test/Database") {}

  class Caller extends Context.Service<Caller, string>()("cli-test/Caller") {}

  const log: Array<string> = [];

  const Write = Action.make("write", {
    description: "Writes",
    access: "write",
    input: { value: Schema.String },
    success: Schema.String,
  });

  const app = Action.implement(
    Write,
    Effect.map(
      Database,
      (database) =>
        ({ value }: { readonly value: string }) =>
          Effect.map(Caller, (caller) => `${caller} wrote ${value} to ${database}`),
    ),
    Action.allowAll,
  );

  const database = Layer.effect(
    Database,
    Effect.acquireRelease(
      Effect.sync(() => (log.push("connect"), "db")),
      () => Effect.sync(() => log.push("disconnect")),
    ),
  );

  const caller = Effect.sync(() => (log.push("read caller"), "alice"));

  // On the command, not around the run: built when an action runs.
  const cli = ActionCli.make(app, { name: "tool" }).pipe(
    Command.provide(database),
    Command.provideEffect(Caller, caller),
  );

  const single = ActionCli.command(app, Write).pipe(
    Command.provide(database),
    Command.provideEffect(Caller, caller),
  );

  await run(cli, ["--help"]);
  await run(cli, ["write", "--help"]);
  await run(single, ["--help"]);
  expect(failure(await runExit(cli, ["write"]))).toBeInstanceOf(CliError.ShowHelp);
  expect(failure(await runExit(cli, ["writ", "--value", "x"]))).toBeInstanceOf(CliError.ShowHelp);
  expect(failure(await runExit(single, ["--valu", "x"]))).toBeInstanceOf(CliError.ShowHelp);
  expect(log).toEqual([]);

  expect(await lines(cli, ["write", "--value", "x"])).toEqual(['"alice wrote x to db"']);
  expect(log).toEqual(["read caller", "connect", "disconnect"]);

  // The documented limit: the aggregate alone runs its own handler, under the provisions,
  // before showing its help.
  expect(failure(await runExit(cli, []))).toBeInstanceOf(CliError.ShowHelp);
  expect(log).toEqual([
    "read caller",
    "connect",
    "disconnect",
    "read caller",
    "connect",
    "disconnect",
  ]);
});

// A real subprocess compiles TypeScript at startup, which can outlast the default timeout
// under load.
it("runs under Effect's own runner: the result on stdout, a failure's JSON once on stderr, and its exit code", () => {
  const users = (...args: ReadonlyArray<string>) =>
    spawnSync(process.execPath, ["--import", "tsx", "examples/cli.ts", ...args], {
      cwd: process.cwd(),
      encoding: "utf8",
    });

  const found = users("get-user", "--id", "1");

  expect(found.status).toBe(0);
  expect(JSON.parse(found.stdout)).toEqual({ id: "1", name: "Ada" });
  expect(found.stderr).toBe("");

  const missing = users("get-user", "--id", "9");

  expect(missing.status).toBe(1);
  expect(missing.stdout).toBe("");
  expect(missing.stderr.trim().split("\n").at(-1)?.trim()).toBe('{"_tag":"UserNotFound","id":"9"}');
  expect(missing.stderr.match(/UserNotFound/g)).toHaveLength(1);

  const invalid = users("rename-user", "--id", "1", "--name", "");

  expect(invalid.status).toBe(1);
  expect(invalid.stdout).toBe("");
  expect(invalid.stderr).toContain('{"_tag":"InvalidInput","message":"Expected a value with');

  const help = users("--help");

  expect(help.status).toBe(0);
  expect(help.stdout).toContain("rename-user");
  expect(help.stderr).toBe("");
}, 30_000);
