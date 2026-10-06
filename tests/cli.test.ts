import { spawnSync } from "node:child_process";
import { assert, expect, it, vi } from "@effect/vitest";
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
import { CliError, CliOutput, Command, Flag, GlobalFlag } from "effect/cli";
import { HttpClient } from "effect/http";
import * as Action from "../src/Action.js";
import * as ActionCli from "../src/ActionCli.js";
import * as ActionHttp from "../src/ActionHttp.js";
import * as ActionToolkit from "../src/ActionToolkit.js";
import * as Testing from "../src/Testing.js";
import { authenticate } from "../examples/authentication.js";
import { actors, authorize, CurrentActor } from "../examples/authorization.js";
import { Login } from "../examples/binding.js";
import { causeOf, exec, logged, printed } from "./cli-services.js";
import { post, send, withBearer } from "./requests.js";

/** Every line a successful run logs. */
const lines = flow(
  exec,
  logged,
  Effect.map(([, logs]) => logs),
);

/** The typed failure of a failed run: the command's own, or the native parser's. */
const failure = <A, E>(exit: Exit.Exit<A, E>): E | undefined =>
  Option.getOrUndefined(Exit.findErrorOption(exit));

/**
 * The caller of a protected action: no remote caller authenticates on the command line, so
 * the host provides it, as `Command.provideSync(command, Caller, "alice")`.
 */
class Caller extends Context.Service<Caller, string>()("cli-test/Caller") {}

it.effect("takes one flag per input field and no flags for an action without input", () =>
  Effect.gen(function* () {
    const inputs: number[] = [];

    const NumberAction = Action.make("number", {
      description: "Accept an encoded finite number",
      readOnly: false,
      caller: Action.Anyone,
      input: Schema.Struct({ value: Schema.FiniteFromString }),
      success: Schema.FiniteFromString,
    });

    const Empty = Action.make("empty", {
      description: "No input",
      readOnly: false,
      caller: Action.Anyone,
      success: Schema.String,
    });

    const empties: object[] = [];

    const app = Action.implement([NumberAction, Empty], {
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

    // `FiniteFromString` is string-encoded, so its flag is a string flag.
    const number = ActionCli.command(app, NumberAction);
    yield* exec(number, ["--value", "21"]);
    // A struct input takes no whole-input flag.
    expect(failure(yield* Effect.exit(exec(number, ["--input", '{"value":"22"}'])))).toBeInstanceOf(
      CliError.ShowHelp,
    );

    const empty = ActionCli.command(app, Empty);
    yield* exec(empty, []);
    yield* exec(empty, []);
    expect(failure(yield* Effect.exit(exec(empty, ["--input", "{}"])))).toBeInstanceOf(
      CliError.ShowHelp,
    );

    expect(inputs).toEqual([21]);
    // The no-input codec receives a fresh default each invocation.
    expect(empties).toEqual([{}, {}]);
    expect(empties[0]).not.toBe(empties[1]);
  }),
);

it.effect("derives each field's flag from its encoded JSON value", () =>
  Effect.gen(function* () {
    const inputs: unknown[] = [];

    const Flags = Action.make("flags", {
      description: "One field of every kind",
      readOnly: false,
      caller: Action.Anyone,
      input: {
        tenantId: Schema.String,
        count: Schema.Finite,
        dryRun: Schema.Boolean,
        verbose: Schema.optionalKey(Schema.Boolean),
        mode: Schema.Literals(["fast", "safe"]),
        tags: Schema.Array(Schema.String),
        owner: Schema.Struct({ id: Schema.String }),
        note: Schema.optionalKey(Schema.String),
        // A codec whose own encoding is not JSON takes its JSON encoding's string.
        at: Schema.optionalKey(Schema.Date),
      },
      success: Schema.String,
    });

    const app = Action.implement(Flags, (input) =>
      Effect.andThen(
        Effect.sync(() => inputs.push(input)),
        () => Effect.succeed("ok"),
      ),
    );

    const command = ActionCli.command(app, Flags);

    yield* exec(command, [
      "--tenant-id",
      "acme",
      "--count",
      "2.5",
      "--dry-run",
      "--verbose",
      "--mode",
      "fast",
      "--tags",
      "a",
      "--tags",
      "b",
      "--owner",
      '{"id":"alice"}',
      "--note",
      "hi",
      "--at",
      "2026-01-02T03:04:05.000Z",
    ]);

    // An omitted required boolean is a switch left off, an omitted optional field is absent,
    // and a repeated flag given none is an empty array.
    yield* exec(command, [
      "--tenant-id",
      "acme",
      "--count",
      "1",
      "--mode",
      "safe",
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
        at: new Date("2026-01-02T03:04:05.000Z"),
      },
      { tenantId: "acme", count: 1, dryRun: false, mode: "safe", tags: [], owner: { id: "bob" } },
    ]);

    const required = ["--count", "1", "--mode", "fast", "--owner", '{"id":"a"}'];

    // A choice is parsed natively: another value shows help.
    const slow = failure(
      yield* Effect.exit(
        exec(command, ["--tenant-id", "acme", "--count", "1", "--mode", "slow", "--owner", "{}"]),
      ),
    );

    expect(slow).toBeInstanceOf(CliError.ShowHelp);

    if (slow instanceof CliError.ShowHelp) {
      expect(slow.errors[0]).toBeInstanceOf(CliError.InvalidValue);
    }

    // Any other flag takes JSON, or its text when it is not JSON, for the schema to decode:
    // input it refuses is `InvalidInput`, as over HTTP, naming the field.
    for (const [field, args] of [
      // The required flags, `--count` given text that is not JSON.
      ["count", ["--tenant-id", "acme", ...required.with(1, "many")]],
      ["owner", ["--tenant-id", "acme", ...required.with(5, "[")]],
    ] as const) {
      const refused = causeOf(yield* Effect.exit(exec(command, args)));

      expect(refused).toBeInstanceOf(Action.InvalidInput);

      if (refused instanceof Action.InvalidInput)
        expect(refused.message).toContain(`at ["${field}"]`);
    }

    // A required field's flag is required by the parser, which shows help without it.
    const missing = failure(yield* Effect.exit(exec(command, required)));
    expect(missing).toBeInstanceOf(CliError.ShowHelp);

    if (missing instanceof CliError.ShowHelp) {
      expect(missing.errors).toEqual([new CliError.MissingOption({ option: "tenant-id" })]);
    }

    // A JSON flag holding JSON of the wrong shape is invalid input as well.
    expect(
      causeOf(
        yield* Effect.exit(exec(command, ["--tenant-id", "acme", ...required.with(5, "[1]")])),
      ),
    ).toBeInstanceOf(Action.InvalidInput);

    // An undeclared field in a JSON flag is refused, not dropped: a misspelling is an error.
    expect(
      causeOf(
        yield* Effect.exit(
          exec(command, [
            "--tenant-id",
            "acme",
            "--count",
            "1",
            "--mode",
            "fast",
            "--owner",
            '{"id":"a","nmae":"Ada"}',
          ]),
        ),
      ),
    ).toBeInstanceOf(Action.InvalidInput);

    expect(inputs).toHaveLength(2);
  }),
);

it.effect(
  "repeats the flag of an array of strings or numbers, one element per occurrence but `[]`",
  () =>
    Effect.gen(function* () {
      const inputs: unknown[] = [];

      const Search = Action.make("search", {
        description: "Search with some providers",
        readOnly: true,
        caller: Action.Anyone,
        input: {
          query: Schema.String,
          provider: Schema.NonEmptyArray(Schema.Literals(["exa", "hn"])),
          site: Schema.optionalKey(Schema.Array(Schema.String)),
          limit: Schema.Array(Schema.Finite),
          // An array of objects takes JSON, as any other value flag.
          filters: Schema.Array(Schema.Struct({ key: Schema.String })),
        },
        success: Schema.String,
      });

      const app = Action.implement(Search, (input) =>
        Effect.andThen(
          Effect.sync(() => inputs.push(input)),
          () => Effect.succeed("ok"),
        ),
      );

      const command = ActionCli.command(app, Search, { positional: ["query"] });

      yield* exec(command, [
        "golang",
        "--provider",
        "exa",
        "--provider",
        "hn",
        "--site",
        "go.dev",
        "--limit",
        "3",
        "--limit",
        "5",
        "--filters",
        '[{"key":"lang"}]',
      ]);
      // None of an optional array's flag leaves it out, and none of a required one is `[]`.
      yield* exec(command, ["golang", "--provider", "hn", "--filters", "[]"]);
      // An occurrence of `[]` adds no element, a choice's included, so it alone sends `[]`.
      yield* exec(command, [
        "golang",
        "--provider",
        "hn",
        "--provider",
        "[]",
        "--site",
        "[]",
        "--limit",
        "[]",
        "--filters",
        "[]",
      ]);

      expect(inputs).toStrictEqual([
        {
          query: "golang",
          provider: ["exa", "hn"],
          site: ["go.dev"],
          limit: [3, 5],
          filters: [{ key: "lang" }],
        },
        { query: "golang", provider: ["hn"], limit: [], filters: [] },
        { query: "golang", provider: ["hn"], site: [], limit: [], filters: [] },
      ]);

      // A non-empty array's flag is required once, which the parser reports missing.
      const missing = failure(yield* Effect.exit(exec(command, ["golang", "--filters", "[]"])));
      expect(missing).toBeInstanceOf(CliError.ShowHelp);

      if (missing instanceof CliError.ShowHelp) {
        expect(missing.errors).toEqual([new CliError.MissingOption({ option: "provider" })]);
      }

      // Each occurrence is parsed as one element: a choice natively, anything else for the
      // schema to decode, which names the element.
      const other = ["golang", "--provider", "bing", "--filters", "[]"];
      expect(failure(yield* Effect.exit(exec(command, other)))).toBeInstanceOf(CliError.ShowHelp);

      const many = ["golang", "--provider", "hn", "--limit", "many", "--filters", "[]"];
      const refused = causeOf(yield* Effect.exit(exec(command, many)));

      expect(refused).toBeInstanceOf(Action.InvalidInput);

      if (refused instanceof Action.InvalidInput) expect(refused.message).toContain('["limit"][0]');

      expect(inputs).toHaveLength(3);
    }),
);

it.effect(
  "keeps JSON that breaks a rule as JSON, for the schema to report the rule and its path",
  () =>
    Effect.gen(function* () {
      const inputs: unknown[] = [];

      const Ruled = Action.make("ruled", {
        description: "Fields with rules beyond their kind",
        readOnly: false,
        caller: Action.Anyone,
        input: {
          tags: Schema.Union([
            Schema.String,
            Schema.Array(Schema.String).check(Schema.isMaxLength(3)),
          ]),
          width: Schema.Int.check(Schema.isGreaterThan(0)),
          owner: Schema.Struct({ id: Schema.String }),
        },
      });

      const command = ActionCli.command(
        Action.implement(Ruled, (input) => Effect.sync(() => void inputs.push(input))),
        Ruled,
      );

      const valid = ["--width", "2", "--owner", '{"id":"a"}'];

      // Four tags break the rule: invalid input, never the JSON's text taken as a string.
      const tags = causeOf(
        yield* Effect.exit(exec(command, ["--tags", '["a","b","c","d"]', ...valid])),
      );

      expect(tags).toBeInstanceOf(Action.InvalidInput);

      // The schema's own message and path, not "Expected number" or "Expected object".
      const width = causeOf(
        yield* Effect.exit(
          exec(command, ["--tags", "x", "--width", "1.5", "--owner", '{"id":"a"}']),
        ),
      );

      expect(width).toBeInstanceOf(Action.InvalidInput);

      if (width instanceof Action.InvalidInput)
        expect(width.message).toContain("Expected an integer");

      const owner = causeOf(
        yield* Effect.exit(exec(command, ["--tags", "x", "--width", "2", "--owner", "{}"])),
      );

      expect(owner).toBeInstanceOf(Action.InvalidInput);

      if (owner instanceof Action.InvalidInput) expect(owner.message).toContain('["owner"]["id"]');

      // Text of a kind the field does not take is still text: a plain string here.
      yield* exec(command, ["--tags", "a,b", ...valid]);
      expect(inputs).toEqual([{ tags: "a,b", width: 2, owner: { id: "a" } }]);
    }),
);

it.effect("takes an enum's value and a template literal's text as they are, not as JSON", () =>
  Effect.gen(function* () {
    const inputs: unknown[] = [];

    const Enums = Action.make("enums", {
      description: "Enum and template-literal fields",
      readOnly: false,
      caller: Action.Anyone,
      input: {
        color: Schema.Enum({ Red: "red", Blue: "blue" }),
        level: Schema.Enum({ Low: 1, High: 2 }),
        id: Schema.TemplateLiteral(["id-", Schema.Number]),
      },
    });

    const command = ActionCli.command(
      Action.implement(Enums, (input) => Effect.sync(() => void inputs.push(input))),
      Enums,
    );

    yield* exec(command, ["--color", "red", "--level", "2", "--id", "id-7"]);
    expect(inputs).toStrictEqual([{ color: "red", level: 2, id: "id-7" }]);

    // A string enum is a choice, parsed natively: another value shows help.
    const error = failure(
      yield* Effect.exit(exec(command, ["--color", "green", "--level", "2", "--id", "id-7"])),
    );

    expect(error).toBeInstanceOf(CliError.ShowHelp);

    // The template's pattern is the action's schema's to check.
    expect(
      causeOf(
        yield* Effect.exit(exec(command, ["--color", "red", "--level", "2", "--id", "seven"])),
      ),
    ).toBeInstanceOf(Action.InvalidInput);
  }),
);

// A suspended schema, as a recursive one is written, is read as the schema it stands for.
it.effect("reads a suspended input or field as the schema it stands for, described by it", () =>
  Effect.gen(function* () {
    const inputs: unknown[] = [];

    const Note = Action.make("note", {
      description: "A suspended input of suspended fields",
      readOnly: false,
      caller: Action.Anyone,
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

    const app = Action.implement(Note, (input) =>
      Effect.sync(() => {
        inputs.push(input);
      }),
    );

    // A string field takes `true` as text, a boolean one is a switch, and a field may be
    // positional.
    yield* exec(ActionCli.command(app, Note), ["--text", "true", "--pinned"]);
    yield* exec(ActionCli.command(app, Note, { positional: ["text"] }), ["true"]);

    expect(inputs).toStrictEqual([
      { text: "true", pinned: true },
      { text: "true", pinned: false },
    ]);

    const help = (yield* lines(ActionCli.command(app, Note), ["--help"])).join("\n");
    expect(help).toMatch(/--text string\s+What to note/);
    expect(help).toMatch(/--pinned\s+Keep it on top/);
  }),
);

it.effect("rejects invalid input before acquiring or invoking the handler", () =>
  Effect.gen(function* () {
    let builds = 0;
    let calls = 0;

    const NumberAction = Action.make("number", {
      description: "A finite number",
      readOnly: false,
      caller: Action.Anyone,
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
    );

    const command = ActionCli.command(app, NumberAction);

    expect(causeOf(yield* Effect.exit(exec(command, ["--value", "not-a-number"])))).toBeInstanceOf(
      Action.InvalidInput,
    );
    expect(builds).toBe(0);
    expect(calls).toBe(0);
  }),
);

it.effect("takes an input that is not a struct of fields as one --input JSON flag", () =>
  Effect.gen(function* () {
    const values: unknown[] = [];

    const Scalar = Action.make("scalar", {
      description: "Scalar input",
      readOnly: false,
      caller: Action.Anyone,
      input: Schema.String,
      success: Schema.String,
    });

    const Shape = Action.make("shape", {
      description: "A union root",
      readOnly: false,
      caller: Action.Anyone,
      input: Schema.Union([
        Schema.Struct({ kind: Schema.Literal("circle"), radius: Schema.Finite }),
        Schema.Struct({ kind: Schema.Literal("square"), side: Schema.Finite }),
      ]),
      success: Schema.String,
    });

    const Scores = Action.make("scores", {
      description: "A record's keys are not known in advance",
      readOnly: false,
      caller: Action.Anyone,
      input: Schema.Record(Schema.String, Schema.Finite),
      success: Schema.String,
    });

    const record = <Input>(input: Input) =>
      Effect.andThen(
        Effect.sync(() => values.push(input)),
        () => Effect.succeed("ok"),
      );

    const app = Action.implement([Scalar, Shape, Scores], {
      scalar: record,
      shape: record,
      scores: record,
    });

    yield* exec(ActionCli.command(app, Scalar), ["--input", '"text"']);
    yield* exec(ActionCli.command(app, Shape), ["--input", '{"kind":"square","side":2}']);
    yield* exec(ActionCli.command(app, Scores), ["--input", '{"a":1,"b":2}']);

    // Text that is not JSON is taken as a string: the scalar's plain text, or a shape's error.
    yield* exec(ActionCli.command(app, Scalar), ["--input", "plain"]);

    expect(
      causeOf(yield* Effect.exit(exec(ActionCli.command(app, Shape), ["--input", "{"]))),
    ).toBeInstanceOf(Action.InvalidInput);

    // No field of a union member is a flag of its own.
    expect(
      failure(
        yield* Effect.exit(
          exec(ActionCli.command(app, Shape), ["--kind", "square", "--side", "2"]),
        ),
      ),
    ).toBeInstanceOf(CliError.ShowHelp);
    // A misspelled key of a union member is refused, not dropped.
    expect(
      causeOf(
        yield* Effect.exit(
          exec(ActionCli.command(app, Shape), ["--input", '{"kind":"square","side":2,"sied":3}']),
        ),
      ),
    ).toBeInstanceOf(Action.InvalidInput);

    // Omitted, the input is `{}`: no shape, so invalid input, but a valid record.
    expect(causeOf(yield* Effect.exit(exec(ActionCli.command(app, Shape), [])))).toBeInstanceOf(
      Action.InvalidInput,
    );
    yield* exec(ActionCli.command(app, Scores), []);

    expect(values).toEqual(["text", { kind: "square", side: 2 }, { a: 1, b: 2 }, "plain", {}]);
  }),
);

it.effect("decodes --input only when the command runs, with an asynchronous schema too", () =>
  Effect.gen(function* () {
    let decoded = 0;

    const Delayed = Action.make("delayed", {
      description: "A record decoded asynchronously",
      readOnly: false,
      caller: Action.Anyone,
      input: Schema.Record(Schema.String, Schema.Finite).pipe(
        Schema.decode({
          decode: SchemaGetter.transformEffect((scores: Readonly<Record<string, number>>) =>
            Effect.promise(() => Promise.resolve()).pipe(
              Effect.andThen(Effect.sync(() => void decoded++)),
              Effect.as(scores),
            ),
          ),
          encode: SchemaGetter.passthrough(),
        }),
      ),
      success: Schema.Finite,
    });

    const command = ActionCli.command(
      Action.implement(Delayed, (scores) => Effect.succeed(Object.keys(scores).length)),
      Delayed,
    );

    expect(decoded).toBe(0);
    expect(yield* lines(command, ["--input", '{"a":1}'])).toEqual(["1"]);
    expect(yield* lines(command, [])).toEqual(["0"]);
    expect(decoded).toBe(2);
  }),
);

it.effect("validates a success before rendering it", () =>
  Effect.gen(function* () {
    const invalidRenderer = vi.fn((value: number) => String(value));

    const Invalid = Action.make("invalid", {
      description: "Invalid",
      readOnly: false,
      caller: Action.Anyone,
      success: Schema.Finite,
    });

    const invalid = Action.implement([Invalid], {
      invalid: () => Effect.succeed(Infinity),
    });

    const exit = yield* Effect.exit(
      exec(ActionCli.command(invalid, Invalid, { render: invalidRenderer }), []),
    );

    // A success its schema does not encode is a defect, as a server's 500 is, before anything
    // renders it.
    expect(Exit.hasDies(exit)).toBe(true);
    expect(failure(exit)).toBeUndefined();
    expect(invalidRenderer).not.toHaveBeenCalled();
  }),
);

it.effect("prints nothing for an action that returns nothing, but prints a declared null", () =>
  Effect.gen(function* () {
    const Reset = Action.make("reset", {
      description: "Reset",
      readOnly: false,
      caller: Action.Anyone,
    });

    const Clear = Action.make("clear", {
      description: "Clear",
      readOnly: false,
      caller: Action.Anyone,
      success: Schema.Null,
    });

    const app = Action.implement([Reset, Clear], {
      reset: () => Effect.void,
      clear: () => Effect.succeed(null),
    });

    expect(yield* lines(ActionCli.command(app, Reset), [])).toEqual([]);
    expect(yield* lines(ActionCli.command(app, Clear), [])).toEqual(["null"]);
  }),
);

it.effect("takes flags from a class input's fields, described by their schemas", () =>
  Effect.gen(function* () {
    class Lookup extends Schema.Class<Lookup>("Lookup")({
      userId: Schema.String.annotate({ description: "Whose record to read" }),
      attempts: Schema.Number.annotate({ description: "How many times to try" }),
    }) {}

    const Read = Action.make("readUser", {
      description: "Read a user",
      readOnly: true,
      caller: Action.Anyone,
      input: Lookup,
      success: Schema.String,
    });

    const app = Action.implement(Read, (lookup) =>
      Effect.succeed(`${lookup.userId} ${lookup.attempts} ${lookup instanceof Lookup}`),
    );

    const command = ActionCli.command(app, Read);

    expect(yield* lines(command, ["--user-id", "u1", "--attempts", "2"])).toEqual(['"u1 2 true"']);

    // Encoding drops a transformed field's description; the flag keeps the declared one.
    const help = (yield* lines(command, ["--help"])).join("\n");
    expect(help).toMatch(/--user-id string\s+Whose record to read/);
    expect(help).toMatch(/--attempts value\s+How many times to try/);
  }),
);

it.effect(
  "names a flag without the field's leading underscore, and describes swapped fields by their own schemas",
  () =>
    Effect.gen(function* () {
      const Tag = Action.make("tag", {
        description: "Tags a record",
        readOnly: false,
        caller: Action.Anyone,
        input: Schema.Struct({
          _id: Schema.String,
          a: Schema.String.annotate({ description: "The first" }),
          b: Schema.String.annotate({ description: "The second" }),
        }).pipe(Schema.encodeKeys({ a: "b", b: "a" })),
        success: Schema.String,
      });

      const command = ActionCli.command(
        Action.implement(Tag, (input) => Effect.succeed(`${input._id} ${input.a} ${input.b}`)),
        Tag,
      );

      // A name of underscores alone keeps them, rather than naming nothing.
      const Underscore = Action.make("_", {
        description: "",
        readOnly: true,
        caller: Action.Anyone,
      });

      expect(
        ActionCli.command(
          Action.implement(Underscore, () => Effect.void),
          Underscore,
        ).name,
      ).toBe("_");

      // `--b` fills field `a`, its encoded name, and is described as `a`.
      expect(yield* lines(command, ["--id", "r1", "--b", "first", "--a", "second"])).toEqual([
        '"r1 first second"',
      ]);

      const help = (yield* lines(command, ["--help"])).join("\n");
      expect(help).toMatch(/--id string/);
      expect(help).toMatch(/--b string\s+The first/);
      expect(help).toMatch(/--a string\s+The second/);
    }),
);

it.effect("takes an optional field's plain value, and leaves it out when its flag is omitted", () =>
  Effect.gen(function* () {
    const Search = Action.make("search", {
      description: "Searches",
      readOnly: true,
      caller: Action.Anyone,
      input: {
        query: Schema.optional(Schema.String),
        limit: Schema.optional(Schema.Number.annotate({ description: "How many to return" })),
        exact: Schema.optional(Schema.Boolean).annotate({ description: "Match whole words" }),
      },
      success: Schema.String,
    });

    const command = ActionCli.command(
      Action.implement(Search, (input) => Effect.succeed(JSON.stringify(input))),
      Search,
    );

    expect(yield* lines(command, ["--query", "x", "--limit", "3", "--exact"])).toEqual([
      JSON.stringify(JSON.stringify({ query: "x", limit: 3, exact: true })),
    ]);
    expect(yield* lines(command, [])).toEqual([JSON.stringify("{}")]);

    // A struct field keeps its declared description through encoding, as a class field does,
    // whether the optional field or its value carries it.
    const help = (yield* lines(command, ["--help"])).join("\n");
    expect(help).toMatch(/--query string/);
    expect(help).toMatch(/--limit value\s+How many to return/);
    expect(help).toMatch(/--exact\s+Match whole words/);
  }),
);

it.effect("keeps the null an optional field declares itself, so the flag can send it", () =>
  Effect.gen(function* () {
    const Note = Action.make("note", {
      description: "Sets or clears a note",
      readOnly: false,
      caller: Action.Anyone,
      input: { note: Schema.optionalKey(Schema.NullOr(Schema.String)) },
      success: Schema.String,
    });

    const command = ActionCli.command(
      Action.implement(Note, (input) => Effect.succeed(JSON.stringify(input))),
      Note,
    );

    expect(yield* lines(command, ["--note", "null"])).toEqual([
      JSON.stringify(JSON.stringify({ note: null })),
    ]);
    expect(yield* lines(command, ["--note", '"x"'])).toEqual([
      JSON.stringify(JSON.stringify({ note: "x" })),
    ]);
    expect(yield* lines(command, [])).toEqual([JSON.stringify("{}")]);
  }),
);

it.effect("keeps the null an optional field's codec encodes, under its encoded name too", () =>
  Effect.gen(function* () {
    const note = Schema.OptionFromNullOr(Schema.String);

    const noteOf = (
      input: Schema.Codec<{ readonly note?: Option.Option<string> | undefined }, unknown>,
      flag: string,
    ) =>
      Effect.gen(function* () {
        const Note = Action.make("note", {
          description: "Sets or clears a note",
          readOnly: false,
          caller: Action.Anyone,
          input,
          success: Schema.String,
        });

        const command = ActionCli.command(
          Action.implement(Note, (value) =>
            Effect.succeed(
              value.note === undefined
                ? "absent"
                : Option.match(value.note, {
                    onNone: () => "none",
                    onSome: (text) => `some ${text}`,
                  }),
            ),
          ),
          Note,
        );

        return [
          ...(yield* lines(command, [flag, "null"])),
          ...(yield* lines(command, [flag, "x"])),
          ...(yield* lines(command, [])),
        ];
      });

    const expected = ["none", "some x", "absent"].map((line) => JSON.stringify(line));

    expect(yield* noteOf(Schema.Struct({ note: Schema.optionalKey(note) }), "--note")).toEqual(
      expected,
    );
    expect(yield* noteOf(Schema.Struct({ note: Schema.optional(note) }), "--note")).toEqual(
      expected,
    );
    expect(
      yield* noteOf(
        Schema.Struct({ note: Schema.optionalKey(note) }).pipe(
          Schema.encodeKeys({ note: "wireNote" }),
        ),
        "--wire-note",
      ),
    ).toEqual(expected);
  }),
);

it.effect("takes a number, a non-finite number or a string beside it as JSON or plain text", () =>
  Effect.gen(function* () {
    const Page = Action.make("page", {
      description: "Reads a page",
      readOnly: true,
      caller: Action.Anyone,
      input: {
        limit: Schema.Union([Schema.Finite, Schema.Literal("auto")]),
        scale: Schema.optionalKey(Schema.Number),
      },
      success: Schema.String,
    });

    const command = ActionCli.command(
      Action.implement(Page, ({ limit, scale }) =>
        Effect.succeed([limit, scale].map(String).join(" ")),
      ),
      Page,
    );

    expect(yield* lines(command, ["--limit", "3"])).toEqual(['"3 undefined"']);
    expect(yield* lines(command, ["--limit", "auto"])).toEqual(['"auto undefined"']);
    expect(yield* lines(command, ["--limit", '"auto"'])).toEqual(['"auto undefined"']);
    // `Schema.Number` encodes a non-finite value as text, which its flag takes as it is.
    expect(yield* lines(command, ["--limit", "1", "--scale", "Infinity"])).toEqual([
      '"1 Infinity"',
    ]);
    expect((yield* lines(command, ["--help"])).join("\n")).toMatch(/--limit value/);
  }),
);

it.effect(
  "takes JSON only as a value the field accepts, and nested literal unions as one choice",
  () =>
    Effect.gen(function* () {
      const Tune = Action.make("tune", {
        description: "Tunes a setting",
        readOnly: false,
        caller: Action.Anyone,
        input: {
          mode: Schema.Union([Schema.Literals(["true", "false"]), Schema.Literal("auto")]),
          label: Schema.optionalKey(Schema.Union([Schema.Literal("auto"), Schema.String])),
          extra: Schema.optionalKey(Schema.Json),
        },
        success: Schema.String,
      });

      const command = ActionCli.command(
        Action.implement(Tune, ({ mode, label, extra }) =>
          Effect.succeed(JSON.stringify([mode, label, extra])),
        ),
        Tune,
      );

      // `true` is JSON, but neither field accepts a boolean: each takes the text.
      expect(yield* lines(command, ["--mode", "true", "--label", "true"])).toEqual([
        JSON.stringify(JSON.stringify(["true", "true", undefined])),
      ]);
      // A field that accepts any JSON still takes it as JSON.
      expect(yield* lines(command, ["--mode", "auto", "--extra", '{"a":[1]}'])).toEqual([
        JSON.stringify(JSON.stringify(["auto", undefined, { a: [1] }])),
      ]);
      expect(failure(yield* Effect.exit(exec(command, ["--mode", "maybe"])))).toBeInstanceOf(
        CliError.ShowHelp,
      );
    }),
);

it.effect(
  "hands the action's schema all of the JSON, keys a first union member lacks included",
  () =>
    Effect.gen(function* () {
      // The first member's encoding accepts `{ a: "bad", b: "keep" }` without `b`; only the second
      // decodes it.
      const Pair = Schema.Union([
        Schema.Struct({ a: Schema.FiniteFromString }),
        Schema.Struct({ a: Schema.String, b: Schema.String }),
      ]);

      const Whole = Action.make("whole", {
        description: "Takes a pair",
        readOnly: true,
        caller: Action.Anyone,
        input: Pair,
        success: Schema.String,
      });

      const Nested = Action.make("nested", {
        description: "Takes a pair as a field",
        readOnly: true,
        caller: Action.Anyone,
        input: { pair: Pair },
        success: Schema.String,
      });

      const app = Action.implement([Whole, Nested], {
        whole: (input) => Effect.succeed(JSON.stringify(input)),
        nested: ({ pair }) => Effect.succeed(JSON.stringify(pair)),
      });

      const pair = '{"a":"bad","b":"keep"}';
      const printed = [JSON.stringify(pair)];

      expect(yield* lines(ActionCli.command(app, Whole), ["--input", pair])).toEqual(printed);
      expect(yield* lines(ActionCli.command(app, Nested), ["--pair", pair])).toEqual(printed);
    }),
);

it.effect(
  "lets a field shadow a global flag, and refuses a clash within a command when it is built",
  () =>
    Effect.gen(function* () {
      const Settings = Action.make("settings", {
        description: "Has fields named like global flags and like the renderer's flag",
        readOnly: true,
        caller: Action.Anyone,
        input: { help: Schema.String, logLevel: Schema.String, json: Schema.String },
        success: Schema.String,
      });

      const app = Action.implement(Settings, ({ help, logLevel, json }) =>
        Effect.succeed(`${help} ${logLevel} ${json}`),
      );

      const args = ["--help", "a", "--log-level", "b", "--json", "c"];

      // A field's flag wins over the global flag of the same name.
      expect(yield* lines(ActionCli.command(app, Settings), args)).toEqual(['"a b c"']);

      // Beside a renderer's own `--json`, the command is refused before it ever runs.
      expect(() => ActionCli.command(app, Settings, { render: String })).toThrow(
        "Duplicate flag: --json, claimed by field json and render's --json",
      );

      // So are two fields of one kebab-case name, in a command or an aggregate.
      const Twice = Action.make("twice", {
        description: "Names one field twice",
        readOnly: true,
        caller: Action.Anyone,
        input: { userId: Schema.String, user_id: Schema.String },
        success: Schema.String,
      });

      const twice = Action.implement(Twice, () => Effect.succeed(""));
      const clash = "Duplicate flag: --user-id, claimed by field userId and field user_id";

      expect(() => ActionCli.command(twice, Twice)).toThrow(clash);
      expect(() => ActionCli.make(twice, { name: "tool" })).toThrow(clash);
    }),
);

it.effect(
  "releases a local call's own resources, the authorizer's included, before its builder's",
  () =>
    Effect.gen(function* () {
      const log: string[] = [];

      const Scoped = Action.make("scoped", {
        description: "Opens a resource of its own",
        readOnly: false,
        caller: Caller,
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
        {
          authorize: () =>
            Effect.asVoid(
              Effect.acquireRelease(
                Effect.sync(() => log.push("authorizer acquire")),
                () => Effect.sync(() => log.push("authorizer release")),
              ),
            ),
        },
      );

      yield* exec(Command.provideSync(ActionCli.command(app, Scoped), Caller, "alice"), []);

      expect(log).toEqual([
        "builder acquire",
        "authorizer acquire",
        "handler acquire",
        "handler release",
        "authorizer release",
        "builder release",
      ]);
    }),
);

it.effect(
  "builds a local command's implementation per invocation even where the host built it",
  () =>
    Effect.gen(function* () {
      let acquired = 0;
      let released = 0;

      const Counted = Action.make("counted", {
        description: "Counts builds",
        readOnly: false,
        caller: Action.Anyone,
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
      );

      const inside = yield* Effect.gen(function* () {
        yield* exec(ActionCli.command(app, Counted), []);
        yield* exec(ActionCli.command(app, Counted), []);
        yield* exec(ActionCli.make(app, { name: "counted" }), ["counted"]);

        return { acquired, released };
      }).pipe(Effect.provide(ActionToolkit.make(app).layer));

      // The host's own build, and one per invocation, an aggregate's subcommand's too, each released
      // after its call.
      expect(inside).toEqual({ acquired: 4, released: 3 });
      expect(released).toBe(4);
    }),
);

it.effect(
  "builds a built authorizer per invocation, as the builder, and runs it with the caller's services",
  () =>
    Effect.gen(function* () {
      const log: Array<string> = [];

      const Guarded = Action.make("guarded", {
        description: "Behind a built authorizer",
        readOnly: false,
        caller: Caller,
        success: Schema.String,
      });

      const app = Action.implement(Guarded, () => Effect.succeed("done"), {
        authorize: Effect.acquireRelease(
          Effect.sync(() => {
            log.push("authorizer built");

            return () =>
              Effect.flatMap(Caller, (caller) =>
                caller === "alice" ? Effect.void : Effect.fail(new Action.Forbidden()),
              );
          }),
          () => Effect.sync(() => log.push("authorizer released")),
        ),
      });

      // No remote caller: the host provides the one the authorizer reads.
      const as = (caller: string) =>
        exec(Command.provideSync(ActionCli.command(app, Guarded), Caller, caller), []);

      yield* as("alice");

      expect(causeOf(yield* Effect.exit(as("bob")))).toBeInstanceOf(Action.Forbidden);
      expect(log).toEqual([
        "authorizer built",
        "authorizer released",
        "authorizer built",
        "authorizer released",
      ]);
    }),
);

it.effect(
  "adds --json only to a command with a renderer, without contesting a host's own --json",
  () =>
    Effect.gen(function* () {
      const Plain = Action.make("plain", {
        description: "No renderer",
        readOnly: true,
        caller: Action.Anyone,
        success: Schema.String,
      });

      const Pretty = Action.make("pretty", {
        description: "Rendered",
        readOnly: true,
        caller: Action.Anyone,
        success: Schema.String,
      });

      const app = Action.implement([Plain, Pretty], {
        plain: () => Effect.succeed("plain"),
        pretty: () => Effect.succeed("pretty"),
      });

      const render = vi.fn((value: string) => `rendered ${value}`);
      const pretty = ActionCli.command(app, Pretty, { render });
      expect(yield* lines(pretty, [])).toEqual(["rendered pretty"]);
      expect(yield* lines(pretty, ["--json"])).toEqual(['"pretty"']);
      // `--json` prints the encoded value without calling the renderer.
      expect(render).toHaveBeenCalledTimes(1);
      // Without a renderer the output is JSON already, and the flag does not exist:
      // the native parser treats it as unknown and shows help.
      expect(yield* lines(ActionCli.command(app, Plain), [])).toEqual(['"plain"']);
      expect(
        failure(yield* Effect.exit(exec(ActionCli.command(app, Plain), ["--json"]))),
      ).toBeInstanceOf(CliError.ShowHelp);

      // A regular flag: a host that declares `--json` itself, globally or on a
      // parent, still composes; the projected command keeps its own.
      const HostJson = GlobalFlag.Setting("host-json")({
        flag: Flag.Boolean("json").pipe(Flag.withDefault(false)),
      });

      const hosted = Command.make("host", { json: Flag.Boolean("json") }).pipe(
        Command.withSubcommands([pretty, ActionCli.make(app, { name: "output" })]),
        Command.withGlobalFlags([HostJson]),
      );

      expect(yield* lines(hosted, ["pretty", "--json"])).toEqual(['"pretty"']);
      expect(yield* lines(hosted, ["output", "plain"])).toEqual(['"plain"']);
    }),
);

it.effect("selects a command's implementation by contract identity, not by name", () =>
  Effect.gen(function* () {
    const First = Action.make("same", {
      description: "The first contract named same",
      readOnly: true,
      caller: Action.Anyone,
      success: Schema.String,
    });

    const Second = Action.make("same", {
      description: "Another contract with the same name",
      readOnly: true,
      caller: Action.Anyone,
      success: Schema.String,
    });

    const first = Action.implement(First, () => Effect.succeed("first"));
    const second = Action.implement(Second, () => Effect.succeed("second"));

    expect(yield* lines(ActionCli.command([first, second], Second), [])).toEqual(['"second"']);

    // A contract of the same name is not the implemented one.
    expect(() => ActionCli.command([first], Second)).toThrow(
      'Action "same" has no implementation here',
    );

    const Missing = Action.make("missing", {
      description: "Not implemented here",
      readOnly: true,
      caller: Action.Anyone,
      success: Schema.String,
    });

    expect(() =>
      // @ts-expect-error -- `Missing` is not the action of any implementation passed.
      ActionCli.command(first, Missing),
    ).toThrow('Action "missing" has no implementation here');
  }),
);

it.effect(
  "aggregates implementations under one named command, and refuses one action implemented twice",
  () =>
    Effect.gen(function* () {
      const One = Action.make("one", {
        description: "One",
        readOnly: true,
        caller: Action.Anyone,
        success: Schema.String,
      });

      const Two = Action.make("two", {
        description: "Two",
        readOnly: true,
        caller: Action.Anyone,
        success: Schema.String,
      });

      const one = Action.implement(One, () => Effect.succeed("one"));
      const two = Action.implement(Two, () => Effect.succeed("two"));

      expect(yield* lines(ActionCli.make([one, two], { name: "tool" }), ["two"])).toEqual([
        '"two"',
      ]);

      const Again = Action.make("one", {
        description: "Again",
        readOnly: true,
        caller: Action.Anyone,
        success: Schema.String,
      });

      const again = Action.implement(Again, () => Effect.succeed("again"));

      // One action implemented twice is refused, rather than the first one run.
      const guarded = Action.implement(One, () => Effect.succeed("guarded"));

      expect(() => ActionCli.command([one, guarded], One)).toThrow(
        'Action "one" is implemented twice here',
      );

      // A single command checks only its own action: other names may repeat.
      expect(yield* lines(ActionCli.command([one, two, again], Two), [])).toEqual(['"two"']);
    }),
);

it.effect("names commands and flags in kebab case, unless a name is given", () =>
  Effect.gen(function* () {
    const users: string[] = [];

    const GetUser = Action.make("getUser", {
      description: "Reads a user",
      readOnly: true,
      caller: Action.Anyone,
      input: { userId: Schema.String },
      success: Schema.String,
    });

    const app = Action.implement(GetUser, ({ userId }) =>
      Effect.andThen(
        Effect.sync(() => users.push(userId)),
        () => Effect.succeed(userId),
      ),
    );

    const command = ActionCli.command(app, GetUser);
    expect(command.name).toBe("get-user");
    expect(ActionCli.command(app, GetUser, { name: "whois" }).name).toBe("whois");

    // An acronym is one word.
    const GetHTTPUser = Action.make("getHTTPUser", {
      description: "Reads a user over HTTP",
      readOnly: true,
      caller: Action.Anyone,
      success: Schema.String,
    });

    const http = Action.implement(GetHTTPUser, () => Effect.succeed("http"));
    expect(ActionCli.command(http, GetHTTPUser).name).toBe("get-http-user");

    yield* exec(command, ["--user-id", "alice"]);
    yield* exec(ActionCli.make(app, { name: "users" }), ["get-user", "--user-id", "bob"]);

    // The action's own name is not a subcommand.
    expect(
      failure(
        yield* Effect.exit(
          exec(ActionCli.make(app, { name: "users" }), ["getUser", "--user-id", "x"]),
        ),
      ),
    ).toBeInstanceOf(CliError.ShowHelp);

    expect(users).toEqual(["alice", "bob"]);

    // Two distinct action names can share a kebab-case command name.
    const Snake = Action.make("get_user", {
      description: "Another spelling",
      readOnly: true,
      caller: Action.Anyone,
      success: Schema.String,
    });

    const snake = Action.implement(Snake, () => Effect.succeed("snake"));

    expect(() => ActionCli.make([app, snake], { name: "users" })).toThrow(
      "Duplicate command: get-user, claimed by action getUser and action get_user",
    );
  }),
);

it.effect("acquires only the builder of the selected command's implementation", () =>
  Effect.gen(function* () {
    const builds: string[] = [];

    const Built = Action.make("built", {
      description: "Built",
      readOnly: true,
      caller: Action.Anyone,
      success: Schema.String,
    });

    const Idle = Action.make("idle", {
      description: "Idle",
      readOnly: true,
      caller: Action.Anyone,
      success: Schema.String,
    });

    const built = Action.implement(
      Built,
      Effect.sync(() => {
        builds.push("built");

        return () => Effect.succeed("built");
      }),
    );

    const idle = Action.implement(
      Idle,
      Effect.sync(() => {
        builds.push("idle");

        return () => Effect.succeed("idle");
      }),
    );

    yield* exec(ActionCli.command([built, idle], Built), []);
    yield* exec(ActionCli.make([built, idle], { name: "tool" }), ["built"]);

    expect(builds).toEqual(["built", "built"]);
  }),
);

it.effect("makes subcommands of the listed actions only, from implementations or a binding", () =>
  Effect.gen(function* () {
    const builds: string[] = [];

    const Read = Action.make("read", {
      description: "Read",
      readOnly: true,
      caller: Action.Anyone,
      success: Schema.String,
    });

    const Write = Action.make("write", {
      description: "Write",
      readOnly: false,
      caller: Action.Anyone,
    });

    const Other = Action.make("other", {
      description: "Other",
      readOnly: true,
      caller: Action.Anyone,
    });

    const app = Action.implement(
      [Read, Write],
      Effect.sync(() => {
        builds.push("app");

        return { read: () => Effect.succeed("read"), write: () => Effect.void };
      }),
    );

    const other = Action.implement(
      Other,
      Effect.sync(() => {
        builds.push("other");

        return () => Effect.void;
      }),
    );

    const local = ActionCli.make([app, other], { name: "tool", actions: [Read] });

    expect(yield* lines(local, ["read"])).toEqual(['"read"']);
    expect(local.subcommands.flatMap(({ commands }) => commands.map(({ name }) => name))).toEqual([
      "read",
    ]);
    expect(builds).toEqual(["app"]);

    const remote = ActionCli.make(ActionHttp.make([Read, Write]), {
      name: "tool",
      actions: [Write],
    });

    expect(remote.subcommands.flatMap(({ commands }) => commands.map(({ name }) => name))).toEqual([
      "write",
    ]);

    // Erased, as plain JavaScript or a helper's binding may be: the types refuse it otherwise.
    const readOnly: ActionHttp.Any = ActionHttp.make([Read]);

    expect(() => ActionCli.make(readOnly, { name: "tool", actions: [Write] })).toThrow(
      "Listed in actions, but the binding does not hold it: write",
    );
    // A command of an action the list leaves out is unused, so one record serves several
    // selections; a key no action of the target names is still refused.
    const shared = { read: {}, write: { name: "put" } };
    const reader = ActionCli.make(app, { name: "tool", actions: [Read], commands: shared });

    expect(reader.subcommands.flatMap(({ commands }) => commands.map(({ name }) => name))).toEqual([
      "read",
    ]);
    expect(() =>
      ActionCli.make(readOnly, { name: "tool", commands: Object.fromEntries([["write", {}]]) }),
    ).toThrow("Unknown commands: write");
  }),
);

it.effect(
  "serves a trusted admin a selection of protected actions through the same authorize and checks",
  () =>
    Effect.gen(function* () {
      // A remote verifier would only ever name a reader; only a host supplies the admin.
      class Operator extends Context.Service<
        Operator,
        { readonly id: string; readonly role: "reader" | "admin" }
      >()("cli-test/Operator") {}

      class Throttled extends Schema.TaggedError<Throttled>()("Throttled", {
        id: Schema.String,
      }) {}

      class Limited extends Action.Check<Limited>()("cli-test/Limited", {
        error: Throttled,
        requires: Operator,
      }) {}

      const Read = Action.make("read", {
        description: "Who reads",
        readOnly: true,
        caller: Operator,
        success: Schema.String,
      });

      const Purge = Action.make("purge", {
        description: "Purge everything",
        readOnly: false,
        caller: Operator,
        checks: [Limited],
      });

      const app = Action.implement(
        [Read, Purge],
        { read: () => Effect.map(Operator, ({ id }) => id), purge: () => Effect.void },
        {
          authorize: (action) =>
            Effect.flatMap(Operator, ({ role }) =>
              role === "admin" || action.readOnly
                ? Effect.void
                : Effect.fail(new Action.Forbidden()),
            ),
        },
      );

      // One purge per operator, however many invocations build the check.
      const purged: Array<string> = [];

      const limited = Layer.effect(
        Limited,
        Effect.succeed(() =>
          Effect.flatMap(Operator, ({ id }) =>
            purged.includes(id)
              ? Effect.fail(new Throttled({ id }))
              : Effect.sync(() => {
                  purged.push(id);
                }),
          ),
        ),
      );

      const admin = ActionCli.make(app, { name: "admin", actions: [Purge] }).pipe(
        Command.provide(limited),
        Command.provideSync(Operator, { id: "ops", role: "admin" }),
      );

      const users = ActionCli.make(app, { name: "users" }).pipe(
        Command.provide(limited),
        Command.provideSync(Operator, { id: "ann", role: "reader" }),
      );

      expect(admin.subcommands.flatMap(({ commands }) => commands.map(({ name }) => name))).toEqual(
        ["purge"],
      );

      // The same rule lets the admin through, and its check still applies to them.
      yield* exec(admin, ["purge"]);
      expect(causeOf(yield* Effect.exit(exec(admin, ["purge"])))).toEqual(
        new Throttled({ id: "ops" }),
      );

      // The reader is refused before any check runs.
      expect(causeOf(yield* Effect.exit(exec(users, ["purge"])))).toBeInstanceOf(Action.Forbidden);
      expect(purged).toEqual(["ops"]);
      expect(yield* lines(users, ["read"])).toEqual(['"ann"']);
    }),
);

it.effect(
  "takes the listed fields as positional arguments, in their order, parsed as their flags",
  () =>
    Effect.gen(function* () {
      const inputs: unknown[] = [];

      const Copy = Action.make("copy", {
        description: "Copy a file",
        readOnly: false,
        caller: Action.Anyone,
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

      const app = Action.implement(Copy, (input) =>
        Effect.andThen(
          Effect.sync(() => inputs.push(input)),
          () => Effect.succeed("copied"),
        ),
      );

      const copy = ActionCli.command(app, Copy, {
        positional: ["to", "from", "count", "mode", "verbose", "note"],
      });

      // Read in the listed order, not the input's; a field not listed keeps its flag.
      yield* exec(copy, ["b", "a", "3", "safe", "true"]);
      yield* exec(copy, ["--dry-run", "b", "a", "3", "fast", "false", "hi"]);

      expect(inputs).toEqual([
        { to: "b", from: "a", count: 3, mode: "safe", verbose: true, dryRun: false },
        { to: "b", from: "a", count: 3, mode: "fast", verbose: false, note: "hi", dryRun: true },
      ]);

      // A positional field has no flag, and a missing or invalid argument shows help.
      expect(
        failure(yield* Effect.exit(exec(copy, ["--from", "a", "b", "3", "safe", "true"]))),
      ).toBeInstanceOf(CliError.ShowHelp);
      expect(failure(yield* Effect.exit(exec(copy, ["b", "a", "3"])))).toBeInstanceOf(
        CliError.ShowHelp,
      );
      expect(
        failure(yield* Effect.exit(exec(copy, ["b", "a", "3", "slow", "true"]))),
      ).toBeInstanceOf(CliError.ShowHelp);
      expect(inputs).toHaveLength(2);
    }),
);

it("refuses positional arguments a parser could not read back", () => {
  const Pair = Action.make("pair", {
    description: "A required and an optional field",
    readOnly: false,
    caller: Action.Anyone,
    input: { first: Schema.String, second: Schema.optional(Schema.String) },
  });

  const Scalar = Action.make("scalar", {
    description: "Not a struct",
    readOnly: false,
    caller: Action.Anyone,
    input: Schema.String,
  });

  const pair = Action.implement(Pair, () => Effect.void);
  const scalar = Action.implement(Scalar, () => Effect.void);

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

it.effect("takes an array field as the last positional, one value per argument", () =>
  Effect.gen(function* () {
    const inputs: unknown[] = [];

    const Remove = Action.make("remove", {
      description: "Remove files",
      readOnly: false,
      caller: Action.Anyone,
      input: { force: Schema.Boolean, paths: Schema.Array(Schema.String) },
      success: Schema.String,
    });

    const Tag = Action.make("tag", {
      description: "Tag a file",
      readOnly: false,
      caller: Action.Anyone,
      input: {
        path: Schema.String,
        tags: Schema.optional(Schema.Array(Schema.Literals(["a", "b"]))),
      },
      success: Schema.String,
    });

    const app = Action.implement([Remove, Tag], {
      remove: (input) =>
        Effect.as(
          Effect.sync(() => inputs.push(input)),
          "removed",
        ),
      tag: (input) =>
        Effect.as(
          Effect.sync(() => inputs.push(input)),
          "tagged",
        ),
    });

    const remove = ActionCli.command(app, Remove, { positional: ["paths"] });
    const tag = ActionCli.command(app, Tag, { positional: ["path", "tags"] });

    yield* exec(remove, ["a", "b", "1"]);
    // None is `[]`, as for a repeated flag.
    yield* exec(remove, ["--force"]);
    yield* exec(tag, ["f", "a", "b"]);
    // Optional, none leaves it out, and `[]` clears it.
    yield* exec(tag, ["f"]);
    yield* exec(tag, ["f", "[]"]);

    expect(inputs).toEqual([
      { force: false, paths: ["a", "b", "1"] },
      { force: true, paths: [] },
      { path: "f", tags: ["a", "b"] },
      { path: "f" },
      { path: "f", tags: [] },
    ]);

    // A choice is still one: another value shows help.
    expect(failure(yield* Effect.exit(exec(tag, ["f", "c"])))).toBeInstanceOf(CliError.ShowHelp);

    // It takes every value left, so no argument may follow it.
    expect(() => ActionCli.command(app, Tag, { positional: ["tags", "path"] })).toThrow(
      "Required positional argument after an optional one: path",
    );
    expect(() => ActionCli.command(app, Remove, { positional: ["paths", "force"] })).toThrow(
      "Repeated positional argument before another one: paths",
    );
  }),
);

it.effect("gives a flag the alias its options name, and shows a positional's value", () =>
  Effect.gen(function* () {
    const inputs: unknown[] = [];

    const List = Action.make("list", {
      description: "List records",
      readOnly: true,
      caller: Action.Anyone,
      input: { scale: Schema.Finite, limit: Schema.optional(Schema.Finite), all: Schema.Boolean },
      success: Schema.String,
    });

    const app = Action.implement(List, (input) =>
      Effect.as(
        Effect.sync(() => inputs.push(input)),
        "listed",
      ),
    );

    const list = ActionCli.command(app, List, {
      positional: ["scale"],
      aliases: { limit: "n", all: "a" },
    });

    yield* exec(list, ["-n", "5", "-a", "2"]);
    yield* exec(list, ["--limit", "6", "3"]);
    expect(inputs).toEqual([
      { scale: 2, limit: 5, all: true },
      { scale: 3, limit: 6, all: false },
    ]);

    // JSON or text is shown as a value, an argument's as a flag's.
    const help = (yield* lines(list, ["--help"])).join("\n");
    expect(help).toMatch(/^\s+scale value\s*$/m);
    expect(help).toMatch(/^\s+--limit, -n value\s*$/m);
    expect(help).toMatch(/^\s+--all, -a\s*$/m);

    // A positional field has no flag to alias.
    expect(() =>
      ActionCli.command(app, List, { positional: ["scale"], aliases: { scale: "s" } }),
    ).toThrow("Not a flag's input field: scale");
    // Native flags share one namespace of names, checked here rather than on every parse.
    expect(() => ActionCli.command(app, List, { aliases: { limit: "n", all: "n" } })).toThrow(
      "Duplicate flag: --n, claimed by alias of field limit and alias of field all",
    );
    expect(() => ActionCli.command(app, List, { aliases: { limit: "n", all: "-n" } })).toThrow(
      "Duplicate flag: --n, claimed by alias of field limit and alias of field all",
    );
    expect(() => ActionCli.command(app, List, { aliases: { limit: "all" } })).toThrow(
      "Duplicate flag: --all, claimed by field all and alias of field limit",
    );
    expect(() =>
      ActionCli.command(app, List, { aliases: { limit: "json" }, render: (text) => text }),
    ).toThrow("Duplicate flag: --json, claimed by render's --json and alias of field limit");
  }),
);

it.effect("gives a subcommand of an aggregate the options command takes, by action name", () =>
  Effect.gen(function* () {
    const Read = Action.make("readFile", {
      description: "Read a file",
      readOnly: true,
      caller: Action.Anyone,
      input: { path: Schema.String, lines: Schema.optional(Schema.Finite) },
      success: Schema.String,
    });

    const Size = Action.make("size", {
      description: "A file's size",
      readOnly: true,
      caller: Action.Anyone,
      input: { path: Schema.String },
      success: Schema.Finite,
    });

    const app = Action.implement([Read, Size], {
      readFile: ({ path, lines }) => Effect.succeed(`${path}:${lines ?? "all"}`),
      size: () => Effect.succeed(3),
    });

    const command = ActionCli.make(app, {
      name: "files",
      commands: {
        readFile: { name: "cat", positional: ["path"], render: (text) => text.toUpperCase() },
      },
    });

    expect(yield* lines(command, ["cat", "a.txt", "--lines", "2"])).toEqual(["A.TXT:2"]);
    expect(yield* lines(command, ["cat", "a.txt", "--json"])).toEqual(['"a.txt:all"']);
    // A subcommand without options keeps its defaults.
    expect(yield* lines(command, ["size", "--path", "a.txt"])).toEqual(["3"]);

    // A key no action names is refused, as plain JavaScript may pass it, and so is a name
    // another subcommand has.
    const stale = Object.fromEntries([["read", { name: "read" }]]);

    expect(() => ActionCli.make(app, { name: "files", commands: stale })).toThrow(
      "Unknown commands: read",
    );
    expect(() =>
      ActionCli.make(app, { name: "files", commands: { readFile: { name: "size" } } }),
    ).toThrow("Duplicate command: size");
  }),
);

it.effect(
  "fails with Effect CLI's UserError, which the runner prints on stderr as the JSON HTTP sends",
  () =>
    Effect.gen(function* () {
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
              encode: (reason) =>
                Effect.as(
                  Effect.promise(() => Promise.resolve()),
                  reason,
                ),
            }),
          ),
        ),
      }) {}

      const Read = Action.make("read", {
        description: "Reads a record",
        readOnly: true,
        caller: CurrentActor,
        input: { id: Schema.String.check(Schema.isMinLength(1)) },
        success: Schema.String,
        errors: [Gone, Missing, Over, Busy],
      });

      const over = new Over({ limit: 10n, hint: Option.some("lower it") });

      const Write = Action.make("write", {
        description: "Writes",
        readOnly: false,
        caller: CurrentActor,
      });

      let authorized = 0;

      // The demo rule, which refuses the reader a write.
      const refused = new Action.Forbidden({
        message: "Requires users:write.",
        scopes: ["users:write"],
      });

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
        {
          authorize: (action) =>
            Effect.andThen(
              Effect.sync(() => authorized++),
              authorize(action),
            ),
        },
      );

      // The same caller on both surfaces: provided by the host on the command line, signed in
      // with a token over HTTP.
      const cli = ActionCli.make(app, { name: "records" }).pipe(
        Command.provideSync(CurrentActor, actors.reader),
      );

      const routes = ActionHttp.layer(
        ActionHttp.make([Read, Write], { authentication: Login }),
        app,
      ).pipe(Layer.provide(authenticate));

      /** The body HTTP answers the same call with. */
      const answered = (name: string, body: Schema.Json) =>
        Effect.flatMap(
          send(withBearer(post(`/api/${name}`, body), "reader")),
          (response) => response.text,
        ).pipe(Effect.provide(Testing.layer(routes)));

      const cases = [
        {
          args: ["read", "--id", "gone"],
          body: { id: "gone" },
          cause: new Gone({ id: "gone" }),
          code: 3,
        },
        {
          args: ["read", "--id", "x"],
          body: { id: "x" },
          cause: new Missing({ id: "x" }),
          code: 1,
        },
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
          cause: refused,
          code: 1,
        },
      ];

      for (const { args, body, cause, code } of cases) {
        const [exit, stdout, stderr] = yield* printed(exec(cli, args));

        const [name = ""] = args;

        const sent = yield* answered(name, body);

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

      // Every call above ran the authorizer, the command's and HTTP's.
      expect(authorized).toBe(cases.length * 2);

      // Input that does not decode is the `InvalidInput` HTTP answers, before the authorizer runs.
      const [invalid, , stderr] = yield* printed(exec(cli, ["read", "--id", ""]));

      const sent = yield* answered("read", { id: "" });

      expect(authorized).toBe(cases.length * 2);
      expect(causeOf(invalid)).toBeInstanceOf(Action.InvalidInput);
      expect(sent).toContain('"_tag":"InvalidInput"');
      expect(stderr).toEqual([expect.stringContaining(sent)]);

      // With `renderErrors: false` the runner prints nothing and leaves the failure unmarked,
      // so `runMain` still reports it: the library never marks a failure reported itself.
      const [unrendered, quietOut, quietErr] = yield* printed(
        exec(cli, ["read", "--id", "x"], { renderErrors: false }),
      );

      expect(causeOf(unrendered)).toEqual(new Missing({ id: "x" }));
      expect([quietOut, quietErr]).toEqual([[], []]);
      expect(
        Runtime.getErrorReported(
          Exit.isFailure(unrendered) ? Cause.squash(unrendered.cause) : undefined,
        ),
      ).toBe(true);
    }),
);

it.effect(
  "prints a failure as the host's formatError writes it, on a copy of Effect's formatter",
  () =>
    Effect.gen(function* () {
      class Gone extends Schema.TaggedError<Gone>()("Gone", { id: Schema.String }) {}

      const Remove = Action.make("remove", {
        description: "Removes",
        readOnly: false,
        caller: Action.Anyone,
        errors: [Gone],
      });

      const app = Action.implement(Remove, () => Effect.fail(new Gone({ id: "x" })));

      const formatError = (error: CliError.CliError) => `refused: ${error.message}`;

      // The form ActionCli.md gives, which leaves the default formatter as it is.
      const [exit, stdout, stderr] = yield* exec(ActionCli.command(app, Remove), []).pipe(
        printed,
        Effect.provide(
          CliOutput.layer(Object.assign({}, CliOutput.defaultFormatter(), { formatError })),
        ),
      );

      expect(causeOf(exit)).toEqual(new Gone({ id: "x" }));
      expect([stdout, stderr]).toEqual([[], ['refused: {"_tag":"Gone","id":"x"}']]);
    }),
);

it.effect(
  "describes a failure no schema encodes by its tag or an error's name, its message and causes, never its fields",
  () =>
    Effect.gen(function* () {
      class Unreachable extends Data.TaggedError("Unreachable")<{
        readonly url: string;
        readonly cause: Error;
      }> {}

      // Plain tagged objects, as code outside Effect may fail or throw with.
      const DbDown = Schema.TaggedStruct("DbDown", { url: Schema.String });
      const UserExists = Schema.TaggedStruct("UserExists", { name: Schema.String });

      const Status = Action.make("status", {
        description: "Status",
        readOnly: true,
        caller: Action.Anyone,
      });

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
        );

        const [exit, stdout, stderr] = yield* printed(exec(ActionCli.command(app, Status), []));

        expect(causeOf(exit)).toBe(failure);
        expect(stdout).toEqual([]);
        // The description is the last line, beneath Effect's own heading.
        expect(stderr.map((text) => String(text).trim().split("\n").at(-1)?.trim())).toEqual([
          description,
        ]);
        expect(stderr.join("\n")).not.toContain("hunter2");
      }
    }),
);

it.effect(
  "writes the logs and console output of what a command runs to stderr, and only its result to stdout",
  () =>
    Effect.gen(function* () {
      const Noisy = Action.make("noisy", {
        description: "Logs",
        readOnly: true,
        caller: Caller,
        success: Schema.String,
      });

      const noise = (source: string) =>
        Effect.andThen(Effect.log(`${source} log`), Console.log(`${source} console`));

      const app = Action.implement(
        Noisy,
        Effect.as(noise("builder"), () => Effect.as(noise("handler"), "quiet")),
        { authorize: () => noise("authorizer") },
      );

      const command = Command.provideSync(ActionCli.command(app, Noisy), Caller, "alice");

      // The default logger, and a console logger, which writes through `Console.log`.
      for (const logger of [Layer.empty, Logger.layer([Logger.consoleJson])]) {
        const [exit, stdout, stderr] = yield* exec(command, []).pipe(
          printed,
          Effect.provide(logger),
        );

        const written = stderr.map(String).join("\n");

        expect(Exit.isSuccess(exit)).toBe(true);
        expect(stdout).toEqual(['"quiet"']);

        for (const source of ["builder", "authorizer", "handler"]) {
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

      class Refused extends Schema.TaggedError<Refused>()("Refused", {
        reason: logged("failure"),
      }) {}

      const Coded = Action.make("coded", {
        description: "Logs in its codecs",
        readOnly: true,
        caller: Action.Anyone,
        input: { word: logged("input") },
        success: logged("success"),
        errors: [Refused],
      });

      const coded = ActionCli.command(
        Action.implement(Coded, ({ word }) =>
          word === "no" ? Effect.fail(new Refused({ reason: word })) : Effect.succeed(word),
        ),
        Coded,
      );

      for (const [word, sources, result] of [
        ["yes", ["input decode", "success encode"], ['"yes"']],
        ["no", ["input decode", "failure encode"], []],
      ] as const) {
        const [, stdout, stderr] = yield* printed(exec(coded, ["--word", word]));

        const written = stderr.map(String).join("\n");

        expect(stdout).toEqual(result);

        for (const source of sources) {
          expect(written).toContain(`${source} log`);
          expect(written).toContain(`${source} console`);
        }
      }

      // A remote command's client too, configured on the command, which logs as it sends.
      const Quiet = Action.make("quiet", {
        description: "Answers over HTTP",
        readOnly: true,
        caller: Action.Anyone,
        success: Schema.String,
      });

      const Http = ActionHttp.make([Quiet]);

      const routes = ActionHttp.layer(
        Http,
        Action.implement(Quiet, () => Effect.succeed("quiet")),
      );

      const remote = ActionCli.command(Http, Quiet).pipe(
        Command.provideEffect(
          HttpClient.HttpClient,
          Effect.map(
            HttpClient.HttpClient,
            HttpClient.tapRequest(() => noise("client")),
          ),
        ),
      );

      const [exit, stdout, stderr] = yield* exec(remote, []).pipe(
        printed,
        Effect.provide(Testing.layer(routes)),
      );

      const written = stderr.map(String).join("\n");

      expect(Exit.isSuccess(exit)).toBe(true);
      expect(stdout).toEqual(['"quiet"']);
      expect(written).toContain("client log");
      expect(written).toContain("client console");
    }),
);

it.effect(
  "builds what a command is provided when an action runs, never for help or a parse error",
  () =>
    Effect.gen(function* () {
      class Database extends Context.Service<Database, string>()("cli-test/Database") {}

      class Caller extends Context.Service<Caller, string>()("cli-test/Caller") {}

      const log: Array<string> = [];

      const Write = Action.make("write", {
        description: "Writes",
        readOnly: false,
        caller: Action.Anyone,
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

      yield* exec(cli, ["--help"]);
      yield* exec(cli, ["write", "--help"]);
      yield* exec(single, ["--help"]);
      expect(failure(yield* Effect.exit(exec(cli, ["write"])))).toBeInstanceOf(CliError.ShowHelp);
      expect(failure(yield* Effect.exit(exec(cli, ["writ", "--value", "x"])))).toBeInstanceOf(
        CliError.ShowHelp,
      );
      expect(failure(yield* Effect.exit(exec(single, ["--valu", "x"])))).toBeInstanceOf(
        CliError.ShowHelp,
      );
      expect(log).toEqual([]);

      expect(yield* lines(cli, ["write", "--value", "x"])).toEqual(['"alice wrote x to db"']);
      expect(log).toEqual(["read caller", "connect", "disconnect"]);

      // The documented limit: the aggregate alone runs its own handler, under the provisions,
      // before showing its help.
      expect(failure(yield* Effect.exit(exec(cli, [])))).toBeInstanceOf(CliError.ShowHelp);
      expect(log).toEqual([
        "read caller",
        "connect",
        "disconnect",
        "read caller",
        "connect",
        "disconnect",
      ]);
    }),
);

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
  expect(invalid.stderr).toContain('{"_tag":"InvalidInput"');

  const help = users("--help");

  expect(help.status).toBe(0);
  expect(help.stdout).toContain("rename-user");
  expect(help.stderr).toBe("");
}, 30_000);

it.effect("matches a failure by its tag with Effect's own catchReason, after Command.run", () =>
  Effect.gen(function* () {
    class Missing extends Schema.TaggedError<Missing>()("Missing", { id: Schema.String }) {}

    const Find = Action.make("find", {
      description: "Find",
      readOnly: true,
      caller: Action.Anyone,
      input: { id: Schema.String },
      errors: [Missing],
    });

    const find = ActionCli.command(
      Action.implement(Find, ({ id }) => Effect.fail(new Missing({ id }))),
      Find,
    );

    const recovered = yield* exec(find, ["--id", "9"]).pipe(
      Effect.catchReason("UserError", "Missing", ({ id }) => Effect.succeed(`missing ${id}`)),
    );

    expect(recovered).toBe("missing 9");
  }),
);

it.effect(
  "reports on stderr what runMain would report, once, and keeps its exit code under onStderr",
  () =>
    Effect.gen(function* () {
      const exitCodeOf = <A, E>(exit: Exit.Exit<A, E>) =>
        Exit.isFailure(exit) ? Runtime.getErrorExitCode(Cause.squash(exit.cause)) : 0;

      const reportedOf = <A, E>(exit: Exit.Exit<A, E>) =>
        Exit.isFailure(exit) && Runtime.getErrorReported(Cause.squash(exit.cause));

      // A defect, and a log of a layer the host provides, reach stderr alone.
      const [defect, defectOut, defectErr] = yield* printed(
        ActionCli.onStderr(Effect.log("connecting").pipe(Effect.andThen(Effect.die("bug")))),
      );

      expect(defectOut).toEqual([]);
      expect(defectErr.join("\n")).toContain("connecting");
      expect(defectErr.join("\n")).toContain("bug");
      expect(reportedOf(defect)).toBe(false);
      expect(exitCodeOf(defect)).toBe(1);

      // The defect standing for the report keeps its cause, for a teardown to read.
      assert(Exit.isFailure(defect));
      const report = Cause.squash(defect.cause);
      assert(report instanceof Error && Cause.isCause(report.cause));
      expect(Cause.squash(report.cause)).toBe("bug");

      // A command's failure, which `Command.run` printed, is not reported again, and keeps
      // its exit code.
      class Exiting extends Schema.TaggedError<Exiting>()("Exiting", {}) {
        override get [Runtime.errorExitCode]() {
          return 3;
        }
      }

      const Quit = Action.make("quit", {
        description: "Quit",
        readOnly: true,
        caller: Action.Anyone,
        errors: [Exiting],
      });

      const quit = ActionCli.command(
        Action.implement(Quit, () => Effect.fail(new Exiting())),
        Quit,
      );

      const [failed, failedOut, failedErr] = yield* printed(ActionCli.onStderr(exec(quit, [])));

      expect(failedOut).toEqual([]);
      expect(failedErr.join("\n").match(/Exiting/g)).toHaveLength(1);
      expect(exitCodeOf(failed)).toBe(3);

      // An interruption stays one, so the process exits 130.
      const interrupted = yield* Effect.exit(ActionCli.onStderr(Effect.interrupt));

      assert(Exit.isFailure(interrupted));
      expect(Cause.hasInterruptsOnly(interrupted.cause)).toBe(true);
    }),
);

it.effect(
  "runs a public command of a mixed implementation without its siblings' authorization",
  () =>
    Effect.gen(function* () {
      // What only the protected sibling's built authorizer needs: a public command owes none.
      class Boot extends Context.Service<Boot, true>()("cli-test/Boot") {}

      const Open = Action.make("open", {
        description: "Open to anyone",
        readOnly: true,
        caller: Action.Anyone,
        success: Schema.String,
      });

      const Guarded = Action.make("guarded", {
        description: "Signed in only",
        readOnly: true,
        caller: CurrentActor,
        success: Schema.String,
      });

      const app = Action.implement(
        [Open, Guarded],
        { open: () => Effect.succeed("open"), guarded: () => Effect.succeed("guarded") },
        { authorize: Effect.as(Boot, Action.allowAll) },
      );

      const [result, lines] = yield* printed(exec(ActionCli.command(app, Open), []));

      expect([Exit.isSuccess(result), lines]).toEqual([true, ['"open"']]);
    }),
);
