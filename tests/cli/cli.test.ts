import { spawnSync } from "node:child_process";

import { assert, describe, expect, it, vi } from "@effect/vitest";
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

import * as ActionCli from "../../src/cli/ActionCli.js";
import * as Action from "../../src/contract/Action.js";
import * as ActionHttp from "../../src/http/ActionHttp.js";
import * as Testing from "../../src/testing/Testing.js";
import * as ActionToolkit from "../../src/toolkit/ActionToolkit.js";
import { authenticate } from "../support/app/authentication.js";
import {
  actors,
  authorize,
  CurrentActor,
} from "../support/app/authorization.js";
import { Login } from "../support/app/binding.js";
import { causeOf, exec, logged, printed } from "../support/cli-services.js";
import { post, send, withBearer } from "../support/requests.js";

const lines = flow(
  exec,
  logged,
  Effect.map(([, logs]) => logs)
);

const failure = <A, E>(exit: Exit.Exit<A, E>): E | undefined =>
  Option.getOrUndefined(Exit.findErrorOption(exit));

class Caller extends Context.Service<Caller, string>()("cli-test/Caller") {}

it.effect(
  "takes one flag per input field and no flags for an action without input",
  () =>
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
            () => Effect.succeed(value * 2)
          ),
        empty: (input) =>
          Effect.andThen(
            Effect.sync(() => empties.push(input)),
            () => Effect.succeed("empty")
          ),
      });

      const number = ActionCli.command(app, NumberAction);
      yield* exec(number, ["--value", "21"]);
      expect(
        failure(yield* Effect.exit(exec(number, ["--input", '{"value":"22"}'])))
      ).toBeInstanceOf(CliError.ShowHelp);

      const empty = ActionCli.command(app, Empty);
      yield* exec(empty, []);
      yield* exec(empty, []);
      expect(
        failure(yield* Effect.exit(exec(empty, ["--input", "{}"])))
      ).toBeInstanceOf(CliError.ShowHelp);

      expect(inputs).toStrictEqual([21]);
      expect(empties).toStrictEqual([{}, {}]);
      expect(empties[0]).not.toBe(empties[1]);
    })
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
        at: Schema.optionalKey(Schema.Date),
      },
      success: Schema.String,
    });

    const app = Action.implement(Flags, (input) =>
      Effect.andThen(
        Effect.sync(() => inputs.push(input)),
        () => Effect.succeed("ok")
      )
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
      {
        tenantId: "acme",
        count: 1,
        dryRun: false,
        mode: "safe",
        tags: [],
        owner: { id: "bob" },
      },
    ]);

    const required = [
      "--count",
      "1",
      "--mode",
      "fast",
      "--owner",
      '{"id":"a"}',
    ];

    const slow = failure(
      yield* Effect.exit(
        exec(command, [
          "--tenant-id",
          "acme",
          "--count",
          "1",
          "--mode",
          "slow",
          "--owner",
          "{}",
        ])
      )
    );

    expect(slow).toBeInstanceOf(CliError.ShowHelp);

    if (slow instanceof CliError.ShowHelp) {
      expect(slow.errors[0]).toBeInstanceOf(CliError.InvalidValue);
    }

    for (const [field, args] of [
      ["count", ["--tenant-id", "acme", ...required.with(1, "many")]],
      ["owner", ["--tenant-id", "acme", ...required.with(5, "[")]],
    ] as const) {
      const refused = causeOf(yield* Effect.exit(exec(command, args)));

      expect(refused).toBeInstanceOf(Action.InvalidInput);

      if (refused instanceof Action.InvalidInput) {
        expect(refused.message).toContain(`at ["${field}"]`);
      }
    }

    const missing = failure(yield* Effect.exit(exec(command, required)));
    expect(missing).toBeInstanceOf(CliError.ShowHelp);

    if (missing instanceof CliError.ShowHelp) {
      expect(missing.errors).toStrictEqual([
        new CliError.MissingOption({ option: "tenant-id" }),
      ]);
    }

    expect(
      causeOf(
        yield* Effect.exit(
          exec(command, ["--tenant-id", "acme", ...required.with(5, "[1]")])
        )
      )
    ).toBeInstanceOf(Action.InvalidInput);

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
          ])
        )
      )
    ).toBeInstanceOf(Action.InvalidInput);

    expect(inputs).toHaveLength(2);
  })
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
          filters: Schema.Array(Schema.Struct({ key: Schema.String })),
        },
        success: Schema.String,
      });

      const app = Action.implement(Search, (input) =>
        Effect.andThen(
          Effect.sync(() => inputs.push(input)),
          () => Effect.succeed("ok")
        )
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
      yield* exec(command, ["golang", "--provider", "hn", "--filters", "[]"]);
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

      const missing = failure(
        yield* Effect.exit(exec(command, ["golang", "--filters", "[]"]))
      );

      expect(missing).toBeInstanceOf(CliError.ShowHelp);

      if (missing instanceof CliError.ShowHelp) {
        expect(missing.errors).toStrictEqual([
          new CliError.MissingOption({ option: "provider" }),
        ]);
      }

      const other = ["golang", "--provider", "bing", "--filters", "[]"];
      expect(failure(yield* Effect.exit(exec(command, other)))).toBeInstanceOf(
        CliError.ShowHelp
      );

      const many = [
        "golang",
        "--provider",
        "hn",
        "--limit",
        "many",
        "--filters",
        "[]",
      ];

      const refused = causeOf(yield* Effect.exit(exec(command, many)));

      expect(refused).toBeInstanceOf(Action.InvalidInput);

      if (refused instanceof Action.InvalidInput) {
        expect(refused.message).toContain('["limit"][0]');
      }

      expect(inputs).toHaveLength(3);
    })
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
        Action.implement(Ruled, (input) =>
          Effect.sync(() => {
            inputs.push(input);
          })
        ),
        Ruled
      );

      const valid = ["--width", "2", "--owner", '{"id":"a"}'];

      const tags = causeOf(
        yield* Effect.exit(
          exec(command, ["--tags", '["a","b","c","d"]', ...valid])
        )
      );

      expect(tags).toBeInstanceOf(Action.InvalidInput);

      const width = causeOf(
        yield* Effect.exit(
          exec(command, [
            "--tags",
            "x",
            "--width",
            "1.5",
            "--owner",
            '{"id":"a"}',
          ])
        )
      );

      expect(width).toBeInstanceOf(Action.InvalidInput);

      if (width instanceof Action.InvalidInput) {
        expect(width.message).toContain("Expected an integer");
      }

      const owner = causeOf(
        yield* Effect.exit(
          exec(command, ["--tags", "x", "--width", "2", "--owner", "{}"])
        )
      );

      expect(owner).toBeInstanceOf(Action.InvalidInput);

      if (owner instanceof Action.InvalidInput) {
        expect(owner.message).toContain('["owner"]["id"]');
      }

      yield* exec(command, ["--tags", "a,b", ...valid]);
      expect(inputs).toStrictEqual([
        { tags: "a,b", width: 2, owner: { id: "a" } },
      ]);
    })
);

it.effect(
  "takes an enum's value and a template literal's text as they are, not as JSON",
  () =>
    Effect.gen(function* () {
      const inputs: unknown[] = [];

      const Enums = Action.make("enums", {
        description: "Enum and template-literal fields",
        readOnly: false,
        caller: Action.Anyone,
        input: {
          color: Schema.Enum({ Red: "red", Blue: "blue" }),
          level: Schema.Enum({ Low: 1, High: 2 }),
          id: Schema.TemplateLiteral(["id-", Schema.Finite]),
        },
      });

      const command = ActionCli.command(
        Action.implement(Enums, (input) =>
          Effect.sync(() => {
            inputs.push(input);
          })
        ),
        Enums
      );

      yield* exec(command, ["--color", "red", "--level", "2", "--id", "id-7"]);
      expect(inputs).toStrictEqual([{ color: "red", level: 2, id: "id-7" }]);

      const error = failure(
        yield* Effect.exit(
          exec(command, ["--color", "green", "--level", "2", "--id", "id-7"])
        )
      );

      expect(error).toBeInstanceOf(CliError.ShowHelp);

      expect(
        causeOf(
          yield* Effect.exit(
            exec(command, ["--color", "red", "--level", "2", "--id", "seven"])
          )
        )
      ).toBeInstanceOf(Action.InvalidInput);
    })
);

it.effect(
  "reads a suspended input or field as the schema it stands for, described by it",
  () =>
    Effect.gen(function* () {
      const inputs: unknown[] = [];

      const Note = Action.make("note", {
        description: "A suspended input of suspended fields",
        readOnly: false,
        caller: Action.Anyone,
        input: Schema.suspend(() =>
          Schema.Struct({
            text: Schema.suspend(() =>
              Schema.String.annotate({ description: "What to note" })
            ),
            pinned: Schema.suspend(() =>
              Schema.suspend(() => Schema.Boolean).annotate({
                description: "Keep it on top",
              })
            ),
          })
        ),
      });

      const app = Action.implement(Note, (input) =>
        Effect.sync(() => {
          inputs.push(input);
        })
      );

      yield* exec(ActionCli.command(app, Note), ["--text", "true", "--pinned"]);
      yield* exec(ActionCli.command(app, Note, { positional: ["text"] }), [
        "true",
      ]);

      expect(inputs).toStrictEqual([
        { text: "true", pinned: true },
        { text: "true", pinned: false },
      ]);

      const help = (yield* lines(ActionCli.command(app, Note), [
        "--help",
      ])).join("\n");

      expect(help).toMatch(/--text string\s+What to note/u);
      expect(help).toMatch(/--pinned\s+Keep it on top/u);
    })
);

it.effect(
  "rejects invalid input before acquiring or invoking the handler",
  () =>
    Effect.gen(function* () {
      let builds = 0;
      let calls = 0;

      const NumberAction = Action.make("number", {
        description: "A finite number",
        readOnly: false,
        caller: Action.Anyone,
        input: Schema.Struct({ value: Schema.FiniteFromString }),
        success: Schema.Finite,
      });

      const app = Action.implement(
        [NumberAction],
        Effect.sync(() => {
          builds += 1;

          return {
            number: () =>
              Effect.andThen(
                Effect.sync(() => {
                  calls += 1;
                }),
                () => Effect.succeed(1)
              ),
          };
        })
      );

      const command = ActionCli.command(app, NumberAction);

      expect(
        causeOf(yield* Effect.exit(exec(command, ["--value", "not-a-number"])))
      ).toBeInstanceOf(Action.InvalidInput);
      expect(builds).toBe(0);
      expect(calls).toBe(0);
    })
);

it.effect(
  "takes an input that is not a struct of fields as one --input JSON flag",
  () =>
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
          Schema.Struct({
            kind: Schema.Literal("circle"),
            radius: Schema.Finite,
          }),
          Schema.Struct({
            kind: Schema.Literal("square"),
            side: Schema.Finite,
          }),
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

      const record = (input: Schema.Json) =>
        Effect.andThen(
          Effect.sync(() => values.push(input)),
          () => Effect.succeed("ok")
        );

      const app = Action.implement([Scalar, Shape, Scores], {
        scalar: record,
        shape: record,
        scores: record,
      });

      yield* exec(ActionCli.command(app, Scalar), ["--input", '"text"']);
      yield* exec(ActionCli.command(app, Shape), [
        "--input",
        '{"kind":"square","side":2}',
      ]);
      yield* exec(ActionCli.command(app, Scores), ["--input", '{"a":1,"b":2}']);

      yield* exec(ActionCli.command(app, Scalar), ["--input", "plain"]);

      expect(
        causeOf(
          yield* Effect.exit(
            exec(ActionCli.command(app, Shape), ["--input", "{"])
          )
        )
      ).toBeInstanceOf(Action.InvalidInput);

      expect(
        failure(
          yield* Effect.exit(
            exec(ActionCli.command(app, Shape), [
              "--kind",
              "square",
              "--side",
              "2",
            ])
          )
        )
      ).toBeInstanceOf(CliError.ShowHelp);
      expect(
        causeOf(
          yield* Effect.exit(
            exec(ActionCli.command(app, Shape), [
              "--input",
              '{"kind":"square","side":2,"sied":3}',
            ])
          )
        )
      ).toBeInstanceOf(Action.InvalidInput);

      expect(
        causeOf(yield* Effect.exit(exec(ActionCli.command(app, Shape), [])))
      ).toBeInstanceOf(Action.InvalidInput);
      yield* exec(ActionCli.command(app, Scores), []);

      expect(values).toStrictEqual([
        "text",
        { kind: "square", side: 2 },
        { a: 1, b: 2 },
        "plain",
        {},
      ]);
    })
);

it.effect(
  "decodes --input only when the command runs, with an asynchronous schema too",
  () =>
    Effect.gen(function* () {
      let decoded = 0;

      const Delayed = Action.make("delayed", {
        description: "A record decoded asynchronously",
        readOnly: false,
        caller: Action.Anyone,
        input: Schema.Record(Schema.String, Schema.Finite).pipe(
          Schema.decode({
            decode: SchemaGetter.transformEffect(
              (scores: Readonly<Record<string, number>>) =>
                Effect.promise(async () => {}).pipe(
                  Effect.andThen(
                    Effect.sync(() => {
                      decoded += 1;
                    })
                  ),
                  Effect.as(scores)
                )
            ),
            encode: SchemaGetter.passthrough(),
          })
        ),
        success: Schema.Finite,
      });

      const command = ActionCli.command(
        Action.implement(Delayed, (scores) =>
          Effect.succeed(Object.keys(scores).length)
        ),
        Delayed
      );

      expect(decoded).toBe(0);
      expect(yield* lines(command, ["--input", '{"a":1}'])).toStrictEqual([
        "1",
      ]);
      expect(yield* lines(command, [])).toStrictEqual(["0"]);
      expect(decoded).toBe(2);
    })
);

it.effect("validates a success before rendering it", () =>
  Effect.gen(function* () {
    const invalidRenderer = vi.fn<(value: number) => string>(String);

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
      exec(ActionCli.command(invalid, Invalid, { render: invalidRenderer }), [])
    );

    expect(Exit.hasDies(exit)).toBe(true);
    expect(failure(exit)).toBeUndefined();
    expect(invalidRenderer).not.toHaveBeenCalled();
  })
);

it.effect(
  "prints nothing for an action that returns nothing, but prints a declared null",
  () =>
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

      expect(yield* lines(ActionCli.command(app, Reset), [])).toStrictEqual([]);
      expect(yield* lines(ActionCli.command(app, Clear), [])).toStrictEqual([
        "null",
      ]);
    })
);

it.effect(
  "takes flags from a class input's fields, described by their schemas",
  () =>
    Effect.gen(function* () {
      class Lookup extends Schema.Class<
        Lookup,
        { readonly brand: unique symbol }
      >("Lookup")({
        userId: Schema.String.annotate({ description: "Whose record to read" }),
        attempts: Schema.Finite.annotate({
          description: "How many times to try",
        }),
      }) {}

      const Read = Action.make("readUser", {
        description: "Read a user",
        readOnly: true,
        caller: Action.Anyone,
        input: Lookup,
        success: Schema.String,
      });

      const app = Action.implement(Read, (lookup) =>
        Effect.succeed(
          `${lookup.userId} ${lookup.attempts} ${lookup instanceof Lookup}`
        )
      );

      const command = ActionCli.command(app, Read);

      expect(
        yield* lines(command, ["--user-id", "u1", "--attempts", "2"])
      ).toStrictEqual(['"u1 2 true"']);

      const help = (yield* lines(command, ["--help"])).join("\n");
      expect(help).toMatch(/--user-id string\s+Whose record to read/u);
      expect(help).toMatch(/--attempts value\s+How many times to try/u);
    })
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
        Action.implement(Tag, (input) =>
          Effect.succeed(`${input._id} ${input.a} ${input.b}`)
        ),
        Tag
      );

      const Underscore = Action.make("_", {
        description: "",
        readOnly: true,
        caller: Action.Anyone,
      });

      expect(
        ActionCli.command(
          Action.implement(Underscore, () => Effect.void),
          Underscore
        ).name
      ).toBe("_");

      expect(
        yield* lines(command, ["--id", "r1", "--b", "first", "--a", "second"])
      ).toStrictEqual(['"r1 first second"']);

      const help = (yield* lines(command, ["--help"])).join("\n");
      expect(help).toMatch(/--id string/u);
      expect(help).toMatch(/--b string\s+The first/u);
      expect(help).toMatch(/--a string\s+The second/u);
    })
);

it.effect(
  "takes an optional field's plain value, and leaves it out when its flag is omitted",
  () =>
    Effect.gen(function* () {
      const Search = Action.make("search", {
        description: "Searches",
        readOnly: true,
        caller: Action.Anyone,
        input: {
          query: Schema.optional(Schema.String),
          limit: Schema.optional(
            Schema.Finite.annotate({ description: "How many to return" })
          ),
          exact: Schema.optional(Schema.Boolean).annotate({
            description: "Match whole words",
          }),
        },
        success: Schema.String,
      });

      const command = ActionCli.command(
        Action.implement(Search, (input) =>
          Effect.succeed(JSON.stringify(input))
        ),
        Search
      );

      expect(
        yield* lines(command, ["--query", "x", "--limit", "3", "--exact"])
      ).toStrictEqual([
        JSON.stringify(JSON.stringify({ query: "x", limit: 3, exact: true })),
      ]);
      expect(yield* lines(command, [])).toStrictEqual([JSON.stringify("{}")]);

      const help = (yield* lines(command, ["--help"])).join("\n");
      expect(help).toMatch(/--query string/u);
      expect(help).toMatch(/--limit value\s+How many to return/u);
      expect(help).toMatch(/--exact\s+Match whole words/u);
    })
);

it.effect(
  "keeps the null an optional field declares itself, so the flag can send it",
  () =>
    Effect.gen(function* () {
      const Note = Action.make("note", {
        description: "Sets or clears a note",
        readOnly: false,
        caller: Action.Anyone,
        input: { note: Schema.optionalKey(Schema.NullOr(Schema.String)) },
        success: Schema.String,
      });

      const command = ActionCli.command(
        Action.implement(Note, (input) =>
          Effect.succeed(JSON.stringify(input))
        ),
        Note
      );

      expect(yield* lines(command, ["--note", "null"])).toStrictEqual([
        JSON.stringify(JSON.stringify({ note: null })),
      ]);
      expect(yield* lines(command, ["--note", '"x"'])).toStrictEqual([
        JSON.stringify(JSON.stringify({ note: "x" })),
      ]);
      expect(yield* lines(command, [])).toStrictEqual([JSON.stringify("{}")]);
    })
);

const noteOf = (
  input: Schema.Codec<
    { readonly note?: Option.Option<string> | undefined },
    unknown
  >,
  flag: string
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
              })
        )
      ),
      Note
    );

    return [
      ...(yield* lines(command, [flag, "null"])),
      ...(yield* lines(command, [flag, "x"])),
      ...(yield* lines(command, [])),
    ];
  });

it.effect(
  "keeps the null an optional field's codec encodes, under its encoded name too",
  () =>
    Effect.gen(function* () {
      const note = Schema.OptionFromNullOr(Schema.String);

      const expected = ["none", "some x", "absent"].map((line) =>
        JSON.stringify(line)
      );

      expect(
        yield* noteOf(
          Schema.Struct({ note: Schema.optionalKey(note) }),
          "--note"
        )
      ).toStrictEqual(expected);
      expect(
        yield* noteOf(Schema.Struct({ note: Schema.optional(note) }), "--note")
      ).toStrictEqual(expected);
      expect(
        yield* noteOf(
          Schema.Struct({ note: Schema.optionalKey(note) }).pipe(
            Schema.encodeKeys({ note: "wireNote" })
          ),
          "--wire-note"
        )
      ).toStrictEqual(expected);
    })
);

it.effect(
  "takes a number, a non-finite number or a string beside it as JSON or plain text",
  () =>
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
          Effect.succeed([limit, scale].map(String).join(" "))
        ),
        Page
      );

      expect(yield* lines(command, ["--limit", "3"])).toStrictEqual([
        '"3 undefined"',
      ]);
      expect(yield* lines(command, ["--limit", "auto"])).toStrictEqual([
        '"auto undefined"',
      ]);
      expect(yield* lines(command, ["--limit", '"auto"'])).toStrictEqual([
        '"auto undefined"',
      ]);
      expect(
        yield* lines(command, ["--limit", "1", "--scale", "Infinity"])
      ).toStrictEqual(['"1 Infinity"']);
      expect((yield* lines(command, ["--help"])).join("\n")).toMatch(
        /--limit value/u
      );
    })
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
          mode: Schema.Union([
            Schema.Literals(["true", "false"]),
            Schema.Literal("auto"),
          ]),
          label: Schema.optionalKey(
            Schema.Union([Schema.Literal("auto"), Schema.String])
          ),
          extra: Schema.optionalKey(Schema.Json),
        },
        success: Schema.String,
      });

      const command = ActionCli.command(
        Action.implement(Tune, ({ mode, label, extra }) =>
          Effect.succeed(JSON.stringify([mode, label, extra]))
        ),
        Tune
      );

      expect(
        yield* lines(command, ["--mode", "true", "--label", "true"])
      ).toStrictEqual([
        JSON.stringify(JSON.stringify(["true", "true", undefined])),
      ]);
      expect(
        yield* lines(command, ["--mode", "auto", "--extra", '{"a":[1]}'])
      ).toStrictEqual([
        JSON.stringify(JSON.stringify(["auto", undefined, { a: [1] }])),
      ]);
      expect(
        failure(yield* Effect.exit(exec(command, ["--mode", "maybe"])))
      ).toBeInstanceOf(CliError.ShowHelp);
    })
);

it.effect(
  "hands the action's schema all of the JSON, keys a first union member lacks included",
  () =>
    Effect.gen(function* () {
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
      const expected = [JSON.stringify(pair)];

      expect(
        yield* lines(ActionCli.command(app, Whole), ["--input", pair])
      ).toStrictEqual(expected);
      expect(
        yield* lines(ActionCli.command(app, Nested), ["--pair", pair])
      ).toStrictEqual(expected);
    })
);

it.effect(
  "lets a field shadow a global flag, and refuses a clash within a command when it is built",
  () =>
    Effect.gen(function* () {
      const Settings = Action.make("settings", {
        description:
          "Has fields named like global flags and like the renderer's flag",
        readOnly: true,
        caller: Action.Anyone,
        input: {
          help: Schema.String,
          logLevel: Schema.String,
          json: Schema.String,
        },
        success: Schema.String,
      });

      const app = Action.implement(Settings, ({ help, logLevel, json }) =>
        Effect.succeed(`${help} ${logLevel} ${json}`)
      );

      const args = ["--help", "a", "--log-level", "b", "--json", "c"];

      expect(
        yield* lines(ActionCli.command(app, Settings), args)
      ).toStrictEqual(['"a b c"']);

      expect(() =>
        ActionCli.command(app, Settings, { render: String })
      ).toThrow(
        "Duplicate flag: --json, claimed by field json and render's --json (rename the field or the alias, or drop `render`)"
      );

      const Twice = Action.make("twice", {
        description: "Names one field twice",
        readOnly: true,
        caller: Action.Anyone,
        input: { userId: Schema.String, user_id: Schema.String },
        success: Schema.String,
      });

      const twice = Action.implement(Twice, () => Effect.succeed(""));

      const clash =
        "Duplicate flag: --user-id, claimed by field userId and field user_id";

      expect(() => ActionCli.command(twice, Twice)).toThrow(clash);
      expect(() => ActionCli.make(twice, { name: "tool" })).toThrow(clash);

      const Short = Action.make("short", {
        description: "A one-character field",
        readOnly: true,
        caller: Action.Anyone,
        input: { n: Schema.String, limit: Schema.String },
        success: Schema.String,
      });

      const short = Action.implement(Short, () => Effect.succeed(""));

      expect(() =>
        ActionCli.command(short, Short, { aliases: { limit: "n" } })
      ).toThrow(
        "Duplicate flag: --n, claimed by field n and alias of field limit"
      );
    })
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
                () => Effect.sync(() => log.push("handler release"))
              );
          }),
          () => Effect.sync(() => log.push("builder release"))
        ),
        {
          authorize: () =>
            Effect.asVoid(
              Effect.acquireRelease(
                Effect.sync(() => log.push("authorizer acquire")),
                () => Effect.sync(() => log.push("authorizer release"))
              )
            ),
        }
      );

      yield* exec(
        Command.provideSync(ActionCli.command(app, Scoped), Caller, "alice"),
        []
      );

      expect(log).toStrictEqual([
        "builder acquire",
        "authorizer acquire",
        "handler acquire",
        "handler release",
        "authorizer release",
        "builder release",
      ]);
    })
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
            acquired += 1;

            return () => Effect.succeed("done");
          }),
          () =>
            Effect.sync(() => {
              released += 1;
            })
        )
      );

      const inside = yield* Effect.gen(function* () {
        yield* exec(ActionCli.command(app, Counted), []);
        yield* exec(ActionCli.command(app, Counted), []);
        yield* exec(ActionCli.make(app, { name: "counted" }), ["counted"]);

        return { acquired, released };
      }).pipe(Effect.provide(ActionToolkit.make(app).layer));

      expect(inside).toStrictEqual({ acquired: 4, released: 3 });
      expect(released).toBe(4);
    })
);

it.effect(
  "builds a built authorizer per invocation, as the builder, and runs it with the caller's services",
  () =>
    Effect.gen(function* () {
      const log: string[] = [];

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
                caller === "alice"
                  ? Effect.void
                  : Effect.fail(new Action.Forbidden())
              );
          }),
          () => Effect.sync(() => log.push("authorizer released"))
        ),
      });

      const as = (caller: string) =>
        exec(
          Command.provideSync(ActionCli.command(app, Guarded), Caller, caller),
          []
        );

      yield* as("alice");

      expect(causeOf(yield* Effect.exit(as("bob")))).toBeInstanceOf(
        Action.Forbidden
      );
      expect(log).toStrictEqual([
        "authorizer built",
        "authorizer released",
        "authorizer built",
        "authorizer released",
      ]);
    })
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

      const render = vi.fn<(value: string) => string>(
        (value) => `rendered ${value}`
      );

      const pretty = ActionCli.command(app, Pretty, { render });
      expect(yield* lines(pretty, [])).toStrictEqual(["rendered pretty"]);
      expect(yield* lines(pretty, ["--json"])).toStrictEqual(['"pretty"']);
      expect(render).toHaveBeenCalledOnce();
      expect(yield* lines(ActionCli.command(app, Plain), [])).toStrictEqual([
        '"plain"',
      ]);
      expect(
        failure(
          yield* Effect.exit(exec(ActionCli.command(app, Plain), ["--json"]))
        )
      ).toBeInstanceOf(CliError.ShowHelp);

      const HostJson = GlobalFlag.Setting("host-json")({
        flag: Flag.Boolean("json").pipe(Flag.withDefault(false)),
      });

      const hosted = Command.make("host", { json: Flag.Boolean("json") }).pipe(
        Command.withSubcommands([
          pretty,
          ActionCli.make(app, { name: "output" }),
        ]),
        Command.withGlobalFlags([HostJson])
      );

      expect(yield* lines(hosted, ["pretty", "--json"])).toStrictEqual([
        '"pretty"',
      ]);
      expect(yield* lines(hosted, ["output", "plain"])).toStrictEqual([
        '"plain"',
      ]);
    })
);

it.effect(
  "selects a command's implementation by contract identity, not by name",
  () =>
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

      expect(
        yield* lines(ActionCli.command([first, second], Second), [])
      ).toStrictEqual(['"second"']);

      expect(() => ActionCli.command([first], Second)).toThrow(
        'Action "same" has no implementation here (pass its implementation, and select with the contract value it implements: an equal-looking action does not match)'
      );

      const Missing = Action.make("missing", {
        description: "Not implemented here",
        readOnly: true,
        caller: Action.Anyone,
        success: Schema.String,
      });

      expect(() =>
        // @ts-expect-error -- `Missing` is not the action of any implementation passed.
        ActionCli.command(first, Missing)
      ).toThrow(
        'Action "missing" has no implementation here (pass its implementation, and select with the contract value it implements: an equal-looking action does not match)'
      );
    })
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

      expect(
        yield* lines(ActionCli.make([one, two], { name: "tool" }), ["two"])
      ).toStrictEqual(['"two"']);

      const Again = Action.make("one", {
        description: "Again",
        readOnly: true,
        caller: Action.Anyone,
        success: Schema.String,
      });

      const again = Action.implement(Again, () => Effect.succeed("again"));

      const guarded = Action.implement(One, () => Effect.succeed("guarded"));

      expect(() => ActionCli.command([one, guarded], One)).toThrow(
        'Action "one" is implemented twice here (pass one of them)'
      );

      expect(
        yield* lines(ActionCli.command([one, two, again], Two), [])
      ).toStrictEqual(['"two"']);
    })
);

it.effect(
  "names commands and flags in kebab case, unless a name is given",
  () =>
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
          () => Effect.succeed(userId)
        )
      );

      const command = ActionCli.command(app, GetUser);
      expect(command.name).toBe("get-user");
      expect(ActionCli.command(app, GetUser, { name: "whois" }).name).toBe(
        "whois"
      );

      const GetHTTPUser = Action.make("getHTTPUser", {
        description: "Reads a user over HTTP",
        readOnly: true,
        caller: Action.Anyone,
        success: Schema.String,
      });

      const http = Action.implement(GetHTTPUser, () => Effect.succeed("http"));
      expect(ActionCli.command(http, GetHTTPUser).name).toBe("get-http-user");

      yield* exec(command, ["--user-id", "alice"]);
      yield* exec(ActionCli.make(app, { name: "users" }), [
        "get-user",
        "--user-id",
        "bob",
      ]);

      expect(
        failure(
          yield* Effect.exit(
            exec(ActionCli.make(app, { name: "users" }), [
              "getUser",
              "--user-id",
              "x",
            ])
          )
        )
      ).toBeInstanceOf(CliError.ShowHelp);

      expect(users).toStrictEqual(["alice", "bob"]);

      const Snake = Action.make("get_user", {
        description: "Another spelling",
        readOnly: true,
        caller: Action.Anyone,
        success: Schema.String,
      });

      const snake = Action.implement(Snake, () => Effect.succeed("snake"));

      expect(() => ActionCli.make([app, snake], { name: "users" })).toThrow(
        "Duplicate command: get-user, claimed by action getUser and action get_user (rename one of your subcommands, or give an action's command another name in commands)"
      );
    })
);

it.effect(
  "shows a field's description in help wherever it is annotated: before a check, after one, with none, or on either side of a transformation",
  () =>
    Effect.gen(function* () {
      const even = Schema.makeFilter((value: number) => value % 2 === 0);

      const Save = Action.make("save", {
        description: "Saves a link",
        readOnly: false,
        caller: Action.Anyone,
        input: {
          url: Schema.String.annotate({ description: "Where it is" }).check(
            Schema.isPattern(/^https?:/u)
          ),
          title: Schema.String.check(Schema.isMinLength(1)).annotate({
            description: "Its name",
          }),
          count: Schema.Finite.annotate({ description: "How many" }).check(
            even
          ),
          revised: Schema.String.annotate({ description: "An earlier wording" })
            .check(Schema.isMinLength(1))
            .annotate({ description: "The later wording" })
            .check(Schema.isMaxLength(9)),
          note: Schema.optional(
            Schema.String.annotate({ description: "A remark" })
          ),
          weight: Schema.String.annotate({
            description: "In grams, as digits",
          }).pipe(
            Schema.decodeTo(
              Schema.Finite,
              SchemaTransformation.numberFromString
            )
          ),
          height: Schema.FiniteFromString.annotate({
            description: "In metres",
          }),
          labels: Schema.Array(
            Schema.String.annotate({ description: "A label" })
          ),
          days: Schema.optional(
            Schema.Array(
              Schema.DateTimeUtcFromString.annotate({ description: "A day" })
            )
          ),
          sizes: Schema.Array(
            Schema.String.annotate({ description: "A size, as digits" }).pipe(
              Schema.decodeTo(
                Schema.Finite,
                SchemaTransformation.numberFromString
              )
            )
          ),
          keyed: Schema.String.annotate({ description: "Any text" })
            .check(Schema.isMinLength(1))
            .annotateKey({ description: "What this field holds" }),
          bare: Schema.String.check(Schema.isMinLength(1)),
        },
      });

      const command = ActionCli.command(
        Action.implement(Save, () => Effect.void),
        Save
      );

      const help = (yield* lines(command, ["--help"])).join("\n");

      expect(help).toMatch(/--url string\s+Where it is\n/u);
      expect(help).toMatch(/--title string\s+Its name\n/u);
      expect(help).toMatch(/--count value\s+How many\n/u);
      expect(help).toMatch(/--revised string\s+The later wording\n/u);
      expect(help).toMatch(/--note string\s+A remark\n/u);
      expect(help).toMatch(/--keyed string\s+What this field holds\n/u);
      expect(help).toMatch(
        /--labels string\s+A label\. Repeat for each value\.\n/u
      );
      expect(help).toMatch(
        /--days string\s+A day\. Repeat for each value\.\n/u
      );
      expect(help).toMatch(
        /--sizes string\s+A size, as digits\. Repeat for each value\.\n/u
      );
      expect(help).toMatch(/--weight \w+\s+In grams, as digits\n/u);
      expect(help).toMatch(/--height \w+\s+In metres\n/u);
      expect(help).toMatch(/--bare string\s*\n/u);
    })
);

it.effect(
  "says in a flag's help that it repeats, how a switch sends false, and that a value is JSON",
  () =>
    Effect.gen(function* () {
      const File = Action.make("file", {
        description: "Files a link",
        readOnly: false,
        caller: Action.Anyone,
        input: {
          url: Schema.String,
          tags: Schema.Array(Schema.String).annotate({
            description: "Labels to file it under",
          }),
          also: Schema.optional(Schema.Array(Schema.String)),
          pinned: Schema.Boolean,
          read: Schema.optional(Schema.Boolean).annotate({
            description: "Only read ones?",
          }),
          answers: Schema.Array(
            Schema.Struct({
              id: Schema.String,
              approved: Schema.optional(Schema.Boolean),
            })
          ),
          moves: Schema.NonEmptyArray(
            Schema.Struct({ from: Schema.String, to: Schema.String })
          ),
          pair: Schema.Tuple([
            Schema.Struct({ id: Schema.String }),
            Schema.Struct({ at: Schema.Finite }),
          ]),
          grid: Schema.Array(Schema.Array(Schema.Finite)),
          filter: Schema.optional(Schema.Struct({ id: Schema.String })),
          limit: Schema.optional(Schema.Finite),
        },
        success: Schema.String,
      });

      const sent: unknown[] = [];

      const app = Action.implement(File, (input) =>
        Effect.as(
          Effect.sync(() => sent.push(input)),
          "filed"
        )
      );

      const command = ActionCli.command(app, File);
      const help = (yield* lines(command, ["--help"])).join("\n");

      expect(help).toMatch(/--url string\s*\n/u);
      expect(help).toMatch(
        /--tags string\s+Labels to file it under\. Repeat for each value\.\n/u
      );
      expect(help).toMatch(/--also string\s+Repeat for each value\.\n/u);
      expect(help).toMatch(/--pinned\s+Left out, it sends false\.\n/u);
      expect(help).toMatch(
        /--read\s+Only read ones\? --no-read sends false\.\n/u
      );
      expect(help).toMatch(
        /--answers value\s+A JSON array of \{id, approved\?\}\.\n/u
      );
      expect(help).toMatch(/--moves value\s+A JSON array of \{from, to\}\.\n/u);
      expect(help).toMatch(/--pair value\s+A JSON array\.\n/u);
      expect(help).toMatch(/--grid value\s+A JSON array\.\n/u);
      expect(help).toMatch(/--filter value\s+A JSON object\.\n/u);
      expect(help).toMatch(/--limit value\s*\n/u);

      const listed = ActionCli.command(app, File, { positional: ["tags"] });

      expect((yield* lines(listed, ["--help"])).join("\n")).toMatch(
        /tags\.\.\. string\s+Labels to file it under \(optional\)\n/u
      );

      yield* exec(command, [
        "--url=u",
        "--tags=a",
        "--tags=b",
        "--no-read",
        '--answers=[{"id":"1"}]',
        '--moves=[{"from":"a","to":"b"}]',
        '--pair=[{"id":"1"},{"at":2}]',
        "--grid=[[1]]",
        '--filter={"id":"2"}',
      ]);

      expect(sent).toStrictEqual([
        {
          url: "u",
          tags: ["a", "b"],
          pinned: false,
          read: false,
          answers: [{ id: "1" }],
          moves: [{ from: "a", to: "b" }],
          pair: [{ id: "1" }, { at: 2 }],
          grid: [[1]],
          filter: { id: "2" },
        },
      ]);
    })
);

it.effect(
  "prints through toUserError every field of a failure another action's error also accepts",
  () =>
    Effect.gen(function* () {
      const options = {
        description: "Refuses",
        readOnly: true,
        caller: Action.Anyone,
      } as const;

      const Brief = Action.make("brief", {
        ...options,
        error: Schema.Struct({ reason: Schema.String }),
      });

      const Detailed = Action.make("detailed", {
        ...options,
        error: Schema.Struct({ reason: Schema.String, detail: Schema.String }),
      });

      const app = Action.implement([Brief, Detailed], {
        brief: () => Effect.fail({ reason: "refused" }),
        detailed: () => Effect.fail({ reason: "refused", detail: "keep this" }),
      });

      const own = Command.make("own", {}, () =>
        Effect.flatMap(Action.client(app), (client) => client.detailed()).pipe(
          Effect.scoped,
          ActionCli.toUserError([Brief, Detailed])
        )
      );

      const cli = ActionCli.make(app, { name: "refuser", subcommands: [own] });

      const { stderr: derived } = yield* printed(exec(cli, ["detailed"]));

      expect(derived).toStrictEqual([
        expect.stringContaining('"detail":"keep this"'),
      ]);
      expect((yield* printed(exec(cli, ["own"]))).stderr).toStrictEqual(
        derived
      );
    })
);

const named = (name: string) => Command.make(name, {}, () => Effect.void);

it.effect(
  "runs commands of its own beside the derived ones, and refuses one named as a derived one",
  () =>
    Effect.gen(function* () {
      class Shy extends Schema.TaggedError<
        Shy,
        { readonly brand: unique symbol }
      >()("Shy", {
        of: Schema.String,
      }) {}

      const Greet = Action.make("greet", {
        description: "Greets",
        readOnly: true,
        caller: Action.Anyone,
        input: { name: Schema.String },
        success: Schema.String,
        error: [Shy],
      });

      const app = Action.implement(Greet, ({ name }) =>
        name === "eve"
          ? Effect.fail(new Shy({ of: name }))
          : Effect.succeed(`hello ${name}`)
      );

      const greetEve = Command.make("greet-eve", {}, () =>
        Effect.gen(function* () {
          const client = yield* Action.client(app);

          yield* Console.log(yield* client.greet({ name: "eve" }));
        }).pipe(Effect.scoped, ActionCli.toUserError([Greet]))
      );

      const greetEveryone = Command.make("greet-everyone", {}, () =>
        Effect.gen(function* () {
          const client = yield* Action.client(app);

          yield* Console.log(yield* client.greet({ name: "everyone" }));
        }).pipe(Effect.scoped)
      );

      const refused = Command.make("refused", {}, () =>
        Effect.fail(
          new CliError.UserError({ cause: "no", userMessage: "Not today" })
        )
      );

      const cli = ActionCli.make(app, {
        name: "greeter",
        subcommands: [
          greetEveryone,
          greetEve,
          { group: "Others", commands: [refused] },
        ],
      });

      const { exit: shy, stderr: shyErr } = yield* printed(
        exec(cli, ["greet-eve"])
      );

      expect(failure(shy)).toHaveProperty("cause", new Shy({ of: "eve" }));
      expect(shyErr).toStrictEqual([
        expect.stringContaining('{"_tag":"Shy","of":"eve"}'),
      ]);
      expect(shyErr).toStrictEqual(
        (yield* printed(exec(cli, ["greet", "--name", "eve"]))).stderr
      );

      expect(yield* lines(cli, ["greet", "--name", "ada"])).toStrictEqual([
        '"hello ada"',
      ]);
      expect(yield* lines(cli, ["greet-everyone"])).toStrictEqual([
        "hello everyone",
      ]);

      const { exit, stderr: errors } = yield* printed(exec(cli, ["refused"]));

      expect(failure(exit)).toBeInstanceOf(CliError.UserError);
      expect(errors.join("\n")).toMatch(/Not today/u);

      const help = (yield* lines(cli, ["--help"])).join("\n");

      expect(help).toMatch(/greet\s+Greets/u);
      expect(help).toMatch(/greet-everyone/u);
      expect(help).toMatch(/refused/u);

      expect(() =>
        ActionCli.make(app, { name: "greeter", subcommands: [named("greet")] })
      ).toThrow(
        "Duplicate command: greet, claimed by action greet and subcommands"
      );

      expect(() =>
        ActionCli.make(app, {
          name: "greeter",
          subcommands: [
            named("one"),
            { group: "Others", commands: [named("one")] },
          ],
        })
      ).toThrow("Duplicate command: one");
    })
);

it.effect(
  "acquires only the builder of the selected command's implementation",
  () =>
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
        })
      );

      const idle = Action.implement(
        Idle,
        Effect.sync(() => {
          builds.push("idle");

          return () => Effect.succeed("idle");
        })
      );

      yield* exec(ActionCli.command([built, idle], Built), []);
      yield* exec(ActionCli.make([built, idle], { name: "tool" }), ["built"]);

      expect(builds).toStrictEqual(["built", "built"]);
    })
);

it.effect(
  "fails with a CliError.UserError its builder fails with as it is, printing its message",
  () =>
    Effect.gen(function* () {
      const unset = new CliError.UserError({
        cause: "no token",
        userMessage: "Set TOKEN",
      });

      const Unbuilt = Action.make("unbuilt", {
        description: "Unbuilt",
        readOnly: true,
        caller: Action.Anyone,
        success: Schema.String,
      });

      const app = Action.implement(
        Unbuilt,
        Effect.as(Effect.fail(unset), () => Effect.succeed(""))
      );

      const { exit: single, stderr: singleErr } = yield* printed(
        exec(ActionCli.command(app, Unbuilt), [])
      );

      const { exit: grouped, stderr: groupedErr } = yield* printed(
        exec(ActionCli.make(app, { name: "tool" }), ["unbuilt"])
      );

      expect(failure(single)).toBe(unset);
      expect(failure(grouped)).toBe(unset);
      expect(singleErr).toStrictEqual([expect.stringContaining("Set TOKEN")]);
      expect(singleErr.join("\n")).not.toContain("no token");
      expect(groupedErr).toStrictEqual(singleErr);
    })
);

it.effect(
  "makes subcommands of the listed actions only, from implementations or a binding",
  () =>
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

          return {
            read: () => Effect.succeed("read"),
            write: () => Effect.void,
          };
        })
      );

      const other = Action.implement(
        Other,
        Effect.sync(() => {
          builds.push("other");

          return () => Effect.void;
        })
      );

      const local = ActionCli.make([app, other], {
        name: "tool",
        actions: [Read],
      });

      expect(yield* lines(local, ["read"])).toStrictEqual(['"read"']);
      expect(
        local.subcommands.flatMap(({ commands }) =>
          commands.map(({ name }) => name)
        )
      ).toStrictEqual(["read"]);
      expect(builds).toStrictEqual(["app"]);

      const remote = ActionCli.remote(ActionHttp.make([Read, Write]), {
        name: "tool",
        actions: [Write],
      });

      expect(
        remote.subcommands.flatMap(({ commands }) =>
          commands.map(({ name }) => name)
        )
      ).toStrictEqual(["write"]);

      const erasedBinding: ActionHttp.Any = ActionHttp.make([Read]);

      expect(() =>
        ActionCli.remote(erasedBinding, { name: "tool", actions: [Write] })
      ).toThrow(
        "Listed in actions, but the binding does not hold it: write (add it to the binding's actions)"
      );
      const shared = { read: {}, write: { name: "put" } };

      const reader = ActionCli.make(app, {
        name: "tool",
        actions: [Read],
        commands: shared,
      });

      expect(
        reader.subcommands.flatMap(({ commands }) =>
          commands.map(({ name }) => name)
        )
      ).toStrictEqual(["read"]);
      expect(() =>
        ActionCli.remote(erasedBinding, {
          name: "tool",
          commands: Object.fromEntries([["write", {}]]),
        })
      ).toThrow(
        "Unknown commands: write (key it by the action's own name, not its command's)"
      );
    })
);

it.effect(
  "serves a trusted admin a selection of protected actions through the same authorize",
  () =>
    Effect.gen(function* () {
      class Operator extends Context.Service<
        Operator,
        { readonly id: string; readonly role: "reader" | "admin" }
      >()("cli-test/Operator") {}

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
      });

      const purged: string[] = [];

      const app = Action.implement(
        [Read, Purge],
        {
          read: () => Effect.map(Operator, ({ id }) => id),
          purge: () =>
            Effect.map(Operator, ({ id }) => {
              purged.push(id);
            }),
        },
        {
          authorize: (action) =>
            Effect.flatMap(Operator, ({ role }) =>
              role === "admin" || action.readOnly
                ? Effect.void
                : Effect.fail(new Action.Forbidden())
            ),
        }
      );

      const admin = ActionCli.make(app, {
        name: "admin",
        actions: [Purge],
      }).pipe(Command.provideSync(Operator, { id: "ops", role: "admin" }));

      const users = ActionCli.make(app, { name: "users" }).pipe(
        Command.provideSync(Operator, { id: "ann", role: "reader" })
      );

      expect(
        admin.subcommands.flatMap(({ commands }) =>
          commands.map(({ name }) => name)
        )
      ).toStrictEqual(["purge"]);

      yield* exec(admin, ["purge"]);

      expect(
        causeOf(yield* Effect.exit(exec(users, ["purge"])))
      ).toBeInstanceOf(Action.Forbidden);
      expect(purged).toStrictEqual(["ops"]);
      expect(yield* lines(users, ["read"])).toStrictEqual(['"ann"']);
    })
);

describe("positional arguments", () => {
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
            () => Effect.succeed("copied")
          )
        );

        const copy = ActionCli.command(app, Copy, {
          positional: ["to", "from", "count", "mode", "verbose", "note"],
        });

        yield* exec(copy, ["b", "a", "3", "safe", "true"]);
        yield* exec(copy, ["--dry-run", "b", "a", "3", "fast", "false", "hi"]);

        expect(inputs).toStrictEqual([
          {
            to: "b",
            from: "a",
            count: 3,
            mode: "safe",
            verbose: true,
            dryRun: false,
          },
          {
            to: "b",
            from: "a",
            count: 3,
            mode: "fast",
            verbose: false,
            note: "hi",
            dryRun: true,
          },
        ]);

        expect(
          failure(
            yield* Effect.exit(
              exec(copy, ["--from", "a", "b", "3", "safe", "true"])
            )
          )
        ).toBeInstanceOf(CliError.ShowHelp);
        expect(
          failure(yield* Effect.exit(exec(copy, ["b", "a", "3"])))
        ).toBeInstanceOf(CliError.ShowHelp);
        expect(
          failure(
            yield* Effect.exit(exec(copy, ["b", "a", "3", "slow", "true"]))
          )
        ).toBeInstanceOf(CliError.ShowHelp);
        expect(inputs).toHaveLength(2);
      })
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

    expect(() =>
      ActionCli.command(pair, Pair, { positional: ["first", "first"] })
    ).toThrow("Duplicate positional argument: first (list each field once)");
    expect(() =>
      ActionCli.command(pair, Pair, { positional: ["second", "first"] })
    ).toThrow(
      "Required positional argument after an optional one: first (list every required field first)"
    );
    expect(() =>
      ActionCli.command(pair, Pair, {
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion
        positional: ["third"] as never,
      })
    ).toThrow(
      "Not an input field: third (positional names fields of the action's input)"
    );
    expect(() =>
      ActionCli.command(scalar, Scalar, {
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion
        positional: ["length"] as never,
      })
    ).toThrow(
      "Positional arguments need named input fields: length (the input is not a struct, so it is one --input flag: drop the option)"
    );
  });

  it.effect(
    "takes an array field as the last positional, one value per argument",
    () =>
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
              "removed"
            ),
          tag: (input) =>
            Effect.as(
              Effect.sync(() => inputs.push(input)),
              "tagged"
            ),
        });

        const remove = ActionCli.command(app, Remove, {
          positional: ["paths"],
        });

        const tag = ActionCli.command(app, Tag, {
          positional: ["path", "tags"],
        });

        yield* exec(remove, ["a", "b", "1"]);
        yield* exec(remove, ["--force"]);
        yield* exec(tag, ["f", "a", "b"]);
        yield* exec(tag, ["f"]);
        yield* exec(tag, ["f", "[]"]);

        expect(inputs).toStrictEqual([
          { force: false, paths: ["a", "b", "1"] },
          { force: true, paths: [] },
          { path: "f", tags: ["a", "b"] },
          { path: "f" },
          { path: "f", tags: [] },
        ]);

        expect(
          failure(yield* Effect.exit(exec(tag, ["f", "c"])))
        ).toBeInstanceOf(CliError.ShowHelp);

        expect(() =>
          ActionCli.command(app, Tag, { positional: ["tags", "path"] })
        ).toThrow(
          "Required positional argument after an optional one: path (list every required field first)"
        );
        expect(() =>
          ActionCli.command(app, Remove, { positional: ["paths", "force"] })
        ).toThrow(
          "Repeated positional argument before another one: paths (list an array field last)"
        );
      })
  );

  it.effect(
    "gives a flag the alias its options name, and shows a positional's value",
    () =>
      Effect.gen(function* () {
        const inputs: unknown[] = [];

        const List = Action.make("list", {
          description: "List records",
          readOnly: true,
          caller: Action.Anyone,
          input: {
            scale: Schema.Finite,
            limit: Schema.optional(Schema.Finite),
            all: Schema.Boolean,
          },
          success: Schema.String,
        });

        const app = Action.implement(List, (input) =>
          Effect.as(
            Effect.sync(() => inputs.push(input)),
            "listed"
          )
        );

        const list = ActionCli.command(app, List, {
          positional: ["scale"],
          aliases: { limit: "n", all: "a" },
        });

        yield* exec(list, ["-n", "5", "-a", "2"]);
        yield* exec(list, ["--limit", "6", "3"]);
        expect(inputs).toStrictEqual([
          { scale: 2, limit: 5, all: true },
          { scale: 3, limit: 6, all: false },
        ]);

        const help = (yield* lines(list, ["--help"])).join("\n");
        expect(help).toMatch(/^\s+scale value\s*$/mu);
        expect(help).toMatch(/^\s+--limit, -n value\s*$/mu);
        expect(help).toMatch(/^\s+--all, -a\s+Left out, it sends false\.$/mu);

        expect(() =>
          ActionCli.command(app, List, {
            positional: ["scale"],
            aliases: { scale: "s" },
          })
        ).toThrow(
          "Not a flag's input field: scale (aliases name fields read from flags, neither positional nor stdin)"
        );
        expect(() =>
          ActionCli.command(app, List, { aliases: { limit: "n", all: "n" } })
        ).toThrow(
          "Duplicate flag: -n, claimed by alias of field limit and alias of field all (rename the field or the alias)"
        );
        expect(() =>
          ActionCli.command(app, List, { aliases: { limit: "n", all: "-n" } })
        ).toThrow("Duplicate flag: -n");
        expect(() =>
          ActionCli.command(app, List, { aliases: { limit: "all" } })
        ).toThrow(
          "Duplicate flag: --all, claimed by field all and alias of field limit"
        );
        expect(() =>
          ActionCli.command(app, List, {
            aliases: { limit: "json" },
            render: (text) => text,
          })
        ).toThrow(
          "Duplicate flag: --json, claimed by render's --json and alias of field limit"
        );
      })
  );
});

it.effect(
  "reads the field its options name from stdin, without the line endings ending it",
  () =>
    Effect.gen(function* () {
      const inputs: unknown[] = [];

      const Store = Action.make("store", {
        description: "Store a secret",
        readOnly: false,
        caller: Action.Anyone,
        input: {
          name: Schema.String,
          apiToken: Schema.String.check(Schema.isMinLength(1)).annotate({
            description: "The token to store",
          }),
          note: Schema.optional(Schema.String),
        },
      });

      const app = Action.implement(Store, (input) =>
        Effect.sync(() => inputs.push(input))
      );

      const store = ActionCli.command(app, Store, { stdin: "apiToken" });

      yield* exec(store, ["--name", "gh"], { stdin: "s3cret\r\n\n" });
      yield* exec(store, ["--name", "pem"], { stdin: "a\nb\n" });
      expect(inputs).toStrictEqual([
        { name: "gh", apiToken: "s3cret" },
        { name: "pem", apiToken: "a\nb" },
      ]);

      const flagged = yield* Effect.exit(
        exec(store, ["--name", "gh", "--api-token", "x"], { stdin: "s3cret" })
      );

      expect(Exit.isFailure(flagged)).toBe(true);
      expect(inputs).toHaveLength(2);

      const help = (yield* lines(store, ["--help"])).join("\n");

      expect(help).toContain("Reads api-token from stdin: The token to store");
      expect(help).not.toContain("--api-token");

      const listing = yield* lines(
        ActionCli.make(app, {
          name: "vault",
          commands: { store: { stdin: "apiToken" } },
        }),
        ["--help"]
      );

      expect(listing.join("\n")).toContain("Store a secret");
      expect(listing.join("\n")).not.toContain("from stdin");

      const refusal =
        "apiToken is read from stdin, which is a terminal: pipe it in";

      const { exit: terminal, stderr: refusals } = yield* printed(
        exec(store, ["--name", "gh"], { stdin: { terminal: true } })
      );

      expect(causeOf(terminal)).toStrictEqual(
        new Action.InvalidInput({
          message: refusal,
          issues: [{ path: ["apiToken"], message: refusal }],
        })
      );
      expect(refusals.join("\n")).toContain('"_tag":"InvalidInput"');

      const { exit: empty } = yield* printed(
        exec(store, ["--name", "gh"], { stdin: "\n" })
      );

      const refused = causeOf(empty);

      expect(refused).toBeInstanceOf(Action.InvalidInput);

      if (refused instanceof Action.InvalidInput) {
        expect(refused.issues[0]?.path).toStrictEqual(["apiToken"]);
      }

      expect(inputs).toHaveLength(2);

      // @ts-expect-error -- An optional field is not read from stdin.
      expect(() => ActionCli.command(app, Store, { stdin: "note" })).toThrow(
        "Not a required input field: note (stdin names a required field of the action's input)"
      );
      expect(() =>
        ActionCli.command(app, Store, {
          stdin: "apiToken",
          positional: ["apiToken"],
        })
      ).toThrow(
        "Both positional and stdin: apiToken (take it from one of them)"
      );
      expect(() =>
        ActionCli.command(app, Store, {
          stdin: "apiToken",
          aliases: { apiToken: "t" },
        })
      ).toThrow(
        "Not a flag's input field: apiToken (aliases name fields read from flags, neither positional nor stdin)"
      );
    })
);

const helpText = <Name extends string, Input, E>(
  command: Command.Command<Name, Input, unknown, E>,
  args: readonly string[]
) => Effect.map(lines(command, args), (logs) => logs.join("\n"));

it.effect(
  "describes a command as its options say, by its action's description otherwise",
  () =>
    Effect.gen(function* () {
      const Store = Action.make("store", {
        description: "Store a secret",
        readOnly: false,
        caller: Action.Anyone,
        input: { apiToken: Schema.String },
      });

      const app = Action.implement(Store, () => Effect.void);
      const description = "Store a token piped in";

      const own = yield* helpText(
        ActionCli.command(app, Store, { description }),
        ["--help"]
      );

      const piped = yield* helpText(
        ActionCli.command(app, Store, { description, stdin: "apiToken" }),
        ["--help"]
      );

      const vault = ActionCli.make(app, {
        name: "vault",
        commands: { store: { description, stdin: "apiToken" } },
      });

      const derived = ActionCli.make(app, { name: "vault" });

      const listing = yield* helpText(vault, ["--help"]);

      expect(own).toContain(description);
      expect(own).not.toContain("Store a secret");
      expect(piped).toMatch(
        /Store a token piped in\s+Reads api-token from stdin\./u
      );
      expect(piped).not.toContain("Store a secret");
      expect(listing).toMatch(/store\s+Store a token piped in$/mu);
      expect(listing).not.toContain("Store a secret");
      expect(
        yield* helpText(ActionCli.command(app, Store), ["--help"])
      ).toContain("Store a secret");
      expect(yield* helpText(derived, ["--help"])).toMatch(
        /store\s+Store a secret$/mu
      );
    })
);

it.effect(
  "reads any kind of field from stdin: a string as text, JSON otherwise",
  () =>
    Effect.gen(function* () {
      const inputs: unknown[] = [];

      const Put = Action.make("put", {
        description: "Put a bundle",
        readOnly: false,
        caller: Action.Anyone,
        input: {
          keys: Schema.Array(Schema.String),
          size: Schema.Finite,
          label: Schema.String,
          on: Schema.Boolean,
          when: Schema.Date,
        },
      });

      const app = Action.implement(Put, (input) =>
        Effect.sync(() => inputs.push(input))
      );

      const put = (
        field: "keys" | "size" | "label" | "on" | "when",
        stdin: string
      ) =>
        exec(
          ActionCli.command(app, Put, { stdin: field }),
          [
            ...(field === "size" ? [] : ["--size", "1"]),
            ...(field === "label" ? [] : ["--label", "x"]),
            ...(field === "when" ? [] : ["--when", "2026-01-01"]),
          ],
          { stdin }
        );

      yield* put("keys", '["a","b"]\n');
      yield* put("size", "2\n");
      yield* put("on", "true\n");
      yield* put("label", '"quoted"');
      yield* put("when", "2026-10-09\n");

      const day = new Date("2026-01-01");

      expect(inputs).toStrictEqual([
        { keys: ["a", "b"], size: 1, label: "x", on: false, when: day },
        { keys: [], size: 2, label: "x", on: false, when: day },
        { keys: [], size: 1, label: "x", on: true, when: day },
        { keys: [], size: 1, label: '"quoted"', on: false, when: day },
        {
          keys: [],
          size: 1,
          label: "x",
          on: false,
          when: new Date("2026-10-09"),
        },
      ]);
    })
);

it.effect(
  "gives a subcommand of an aggregate the options command takes, by action name",
  () =>
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
        readFile: ({ path, lines: count }) =>
          Effect.succeed(`${path}:${count ?? "all"}`),
        size: () => Effect.succeed(3),
      });

      const command = ActionCli.make(app, {
        name: "files",
        commands: {
          readFile: {
            name: "cat",
            positional: ["path"],
            render: (text) => text.toUpperCase(),
          },
        },
      });

      expect(
        yield* lines(command, ["cat", "a.txt", "--lines", "2"])
      ).toStrictEqual(["A.TXT:2"]);
      expect(yield* lines(command, ["cat", "a.txt", "--json"])).toStrictEqual([
        '"a.txt:all"',
      ]);
      expect(yield* lines(command, ["size", "--path", "a.txt"])).toStrictEqual([
        "3",
      ]);

      const stale = Object.fromEntries([["read", { name: "read" }]]);

      expect(() =>
        ActionCli.make(app, { name: "files", commands: stale })
      ).toThrow("Unknown commands: read");
      expect(() =>
        ActionCli.make(app, {
          name: "files",
          commands: { readFile: { name: "size" } },
        })
      ).toThrow(
        "Duplicate command: size, claimed by action readFile and action size"
      );
    })
);

it.effect(
  "fails with Effect CLI's UserError, which the runner prints on stderr as the JSON HTTP sends",
  () =>
    Effect.gen(function* () {
      class Gone extends Schema.TaggedError<
        Gone,
        { readonly brand: unique symbol }
      >()("Gone", {
        id: Schema.String,
      }) {
        override readonly [Runtime.errorExitCode] = 3;
      }

      class Missing extends Schema.TaggedError<
        Missing,
        { readonly brand: unique symbol }
      >()("Missing", { id: Schema.String }, { httpApiStatus: 404 }) {}

      class Over extends Schema.TaggedError<
        Over,
        { readonly brand: unique symbol }
      >()("Over", {
        limit: Schema.BigInt,
        hint: Schema.Option(Schema.String),
      }) {}

      class Busy extends Schema.TaggedError<
        Busy,
        { readonly brand: unique symbol }
      >()("Busy", {
        reason: Schema.String.pipe(
          Schema.decodeTo(
            Schema.String,
            SchemaTransformation.transformEffect({
              decode: (reason) => Effect.succeed(reason),
              encode: (reason) =>
                Effect.as(
                  Effect.promise(async () => {}),
                  reason
                ),
            })
          )
        ),
      }) {}

      const Read = Action.make("read", {
        description: "Reads a record",
        readOnly: true,
        caller: CurrentActor,
        input: { id: Schema.String.check(Schema.isMinLength(1)) },
        success: Schema.String,
        error: [Gone, Missing, Over, Busy],
      });

      const over = new Over({ limit: 10n, hint: Option.some("lower it") });

      const Write = Action.make("write", {
        description: "Writes",
        readOnly: false,
        caller: CurrentActor,
      });

      let authorized = 0;

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
              Match.when("busy", () =>
                Effect.fail(new Busy({ reason: "full" }))
              ),
              Match.orElse(() => Effect.fail(new Missing({ id })))
            ),
          write: () => Effect.void,
        },
        {
          authorize: (action) =>
            Effect.andThen(
              Effect.sync(() => {
                authorized += 1;
              }),
              authorize(action)
            ),
        }
      );

      const cli = ActionCli.make(app, { name: "records" }).pipe(
        Command.provideSync(CurrentActor, actors.reader)
      );

      const routes = ActionHttp.layer(
        ActionHttp.make([Read, Write], { authentication: Login }),
        app
      ).pipe(Layer.provide(authenticate));

      const httpBodyFor = (name: string, body: Schema.Json) =>
        Effect.flatMap(
          send(withBearer(post(`/api/${name}`, body), "reader")),
          (response) => response.text
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
        {
          args: ["read", "--id", "over"],
          body: { id: "over" },
          cause: over,
          code: 1,
        },
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
        const { exit, stdout, stderr } = yield* printed(exec(cli, args));

        const [name = ""] = args;

        const sent = yield* httpBodyFor(name, body);

        expect(causeOf(exit)).toStrictEqual(cause);
        expect(stdout).toStrictEqual([]);
        expect(stderr).toStrictEqual([expect.stringContaining(sent)]);
        expect(sent).toContain(`"_tag":"${cause._tag}"`);

        const reported = Exit.isFailure(exit)
          ? Cause.squash(exit.cause)
          : undefined;

        expect(Runtime.getErrorExitCode(reported)).toBe(code);
        expect(Runtime.getErrorReported(reported)).toBe(false);
      }

      expect(authorized).toBe(cases.length * 2);

      const { exit: invalid, stderr } = yield* printed(
        exec(cli, ["read", "--id", ""])
      );

      const sent = yield* httpBodyFor("read", { id: "" });

      expect(authorized).toBe(cases.length * 2);
      expect(causeOf(invalid)).toBeInstanceOf(Action.InvalidInput);
      expect(sent).toContain('"_tag":"InvalidInput"');
      expect(stderr).toStrictEqual([expect.stringContaining(sent)]);

      const {
        exit: unrendered,
        stdout: quietOut,
        stderr: quietErr,
      } = yield* printed(
        exec(cli, ["read", "--id", "x"], { renderErrors: false })
      );

      expect(causeOf(unrendered)).toStrictEqual(new Missing({ id: "x" }));
      expect([quietOut, quietErr]).toStrictEqual([[], []]);
      expect(
        Runtime.getErrorReported(
          Exit.isFailure(unrendered)
            ? Cause.squash(unrendered.cause)
            : undefined
        )
      ).toBe(true);
    })
);

const formatError = (error: CliError.CliError) => `refused: ${error.message}`;

it.effect(
  "prints a failure as the host's formatError writes it, on a copy of Effect's formatter",
  () =>
    Effect.gen(function* () {
      class Gone extends Schema.TaggedError<
        Gone,
        { readonly brand: unique symbol }
      >()("Gone", {
        id: Schema.String,
      }) {}

      const Remove = Action.make("remove", {
        description: "Removes",
        readOnly: false,
        caller: Action.Anyone,
        error: [Gone],
      });

      const app = Action.implement(Remove, () =>
        Effect.fail(new Gone({ id: "x" }))
      );

      const { exit, stdout, stderr } = yield* exec(
        ActionCli.command(app, Remove),
        []
      ).pipe(
        printed,
        Effect.provide(
          CliOutput.layer({ ...CliOutput.defaultFormatter(), formatError })
        )
      );

      expect(causeOf(exit)).toStrictEqual(new Gone({ id: "x" }));
      expect([stdout, stderr]).toStrictEqual([
        [],
        ['refused: {"_tag":"Gone","id":"x"}'],
      ]);
    })
);

it.effect(
  "describes a failure no schema encodes by its tag or an error's name, its message and causes, never its fields",
  () =>
    Effect.gen(function* () {
      class Unreachable extends Data.TaggedError("Unreachable")<{
        readonly url: string;
        readonly cause: Error;
      }> {}

      const DbDown = Schema.TaggedStruct("DbDown", { url: Schema.String });

      const UserExists = Schema.TaggedStruct("UserExists", {
        name: Schema.String,
      });

      const Status = Action.make("status", {
        description: "Status",
        readOnly: true,
        caller: Action.Anyone,
      });

      const url = "postgres://admin:hunter2@db";

      const looping = new Error("db unreachable");

      looping.cause = looping;

      const failures = [
        [
          new Unreachable({
            url,
            cause: new Error("connect ECONNREFUSED 10.0.0.1:5432"),
          }),
          "Unreachable: Error: connect ECONNREFUSED 10.0.0.1:5432",
        ],
        [DbDown.make({ url }), "DbDown"],
        [UserExists.make({ name: url }), "UserExists"],
        [{ name: url, message: "db unreachable" }, "Error: db unreachable"],
        [
          new Error("db unreachable", { cause: { url } }),
          "Error: db unreachable: Error",
        ],
        [looping, "Error: db unreachable"],
      ] as const;

      for (const [failing, description] of failures) {
        const app = Action.implement(
          Status,
          Effect.as(Effect.fail(failing), () => Effect.void)
        );

        const { exit, stdout, stderr } = yield* printed(
          exec(ActionCli.command(app, Status), [])
        );

        expect(causeOf(exit)).toBe(failing);
        expect(stdout).toStrictEqual([]);
        expect(
          stderr.map((text) => String(text).trim().split("\n").at(-1)?.trim())
        ).toStrictEqual([description]);
        expect(stderr.join("\n")).not.toContain("hunter2");
      }
    })
);

const noise = (source: string) =>
  Effect.andThen(Effect.log(`${source} log`), Console.log(`${source} console`));

const noisyString = (source: string) =>
  Schema.String.pipe(
    Schema.decodeTo(
      Schema.String,
      SchemaTransformation.transformEffect({
        decode: (value) => Effect.as(noise(`${source} decode`), value),
        encode: (value) => Effect.as(noise(`${source} encode`), value),
      })
    )
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

      const app = Action.implement(
        Noisy,
        Effect.as(noise("builder"), () => Effect.as(noise("handler"), "quiet")),
        { authorize: () => noise("authorizer") }
      );

      const command = Command.provideSync(
        ActionCli.command(app, Noisy),
        Caller,
        "alice"
      );

      for (const logger of [Layer.empty, Logger.layer([Logger.consoleJson])]) {
        const { exit, stdout, stderr } = yield* exec(command, []).pipe(
          printed,
          Effect.provide(logger)
        );

        const written = stderr.map(String).join("\n");

        expect(Exit.isSuccess(exit)).toBe(true);
        expect(stdout).toStrictEqual(['"quiet"']);

        for (const source of ["builder", "authorizer", "handler"]) {
          expect(written).toContain(`${source} log`);
          expect(written).toContain(`${source} console`);
        }
      }

      class Refused extends Schema.TaggedError<
        Refused,
        { readonly brand: unique symbol }
      >()("Refused", {
        reason: noisyString("failure"),
      }) {}

      const Coded = Action.make("coded", {
        description: "Logs in its codecs",
        readOnly: true,
        caller: Action.Anyone,
        input: { word: noisyString("input") },
        success: noisyString("success"),
        error: [Refused],
      });

      const coded = ActionCli.command(
        Action.implement(Coded, ({ word }) =>
          word === "no"
            ? Effect.fail(new Refused({ reason: word }))
            : Effect.succeed(word)
        ),
        Coded
      );

      for (const [word, sources, result] of [
        ["yes", ["input decode", "success encode"], ['"yes"']],
        ["no", ["input decode", "failure encode"], []],
      ] as const) {
        const { stdout, stderr } = yield* printed(
          exec(coded, ["--word", word])
        );

        const written = stderr.map(String).join("\n");

        expect(stdout).toStrictEqual(result);

        for (const source of sources) {
          expect(written).toContain(`${source} log`);
          expect(written).toContain(`${source} console`);
        }
      }

      const Quiet = Action.make("quiet", {
        description: "Answers over HTTP",
        readOnly: true,
        caller: Action.Anyone,
        success: Schema.String,
      });

      const Http = ActionHttp.make([Quiet]);

      const routes = ActionHttp.layer(
        Http,
        Action.implement(Quiet, () => Effect.succeed("quiet"))
      );

      const remote = ActionCli.remoteCommand(Http, Quiet).pipe(
        Command.provideEffect(
          HttpClient.HttpClient,
          Effect.map(
            HttpClient.HttpClient,
            HttpClient.tapRequest(() => noise("client"))
          )
        )
      );

      const { exit, stdout, stderr } = yield* exec(remote, []).pipe(
        printed,
        Effect.provide(Testing.layer(routes))
      );

      const written = stderr.map(String).join("\n");

      expect(Exit.isSuccess(exit)).toBe(true);
      expect(stdout).toStrictEqual(['"quiet"']);
      expect(written).toContain("client log");
      expect(written).toContain("client console");
    })
);

it.effect(
  "builds what a command is provided when an action runs, never for help or a parse error",
  () =>
    Effect.gen(function* () {
      class Database extends Context.Service<Database, string>()(
        "cli-test/Database"
      ) {}

      const log: string[] = [];

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
              Effect.map(
                Caller,
                (caller) => `${caller} wrote ${value} to ${database}`
              )
        )
      );

      const database = Layer.effect(
        Database,
        Effect.acquireRelease(
          Effect.sync(() => {
            log.push("connect");

            return "db";
          }),
          () => Effect.sync(() => log.push("disconnect"))
        )
      );

      const caller = Effect.sync(() => {
        log.push("read caller");

        return "alice";
      });

      const cli = ActionCli.make(app, { name: "tool" }).pipe(
        Command.provide(database),
        Command.provideEffect(Caller, caller)
      );

      const single = ActionCli.command(app, Write).pipe(
        Command.provide(database),
        Command.provideEffect(Caller, caller)
      );

      yield* exec(cli, ["--help"]);
      yield* exec(cli, ["write", "--help"]);
      yield* exec(single, ["--help"]);
      expect(failure(yield* Effect.exit(exec(cli, ["write"])))).toBeInstanceOf(
        CliError.ShowHelp
      );
      expect(
        failure(yield* Effect.exit(exec(cli, ["writ", "--value", "x"])))
      ).toBeInstanceOf(CliError.ShowHelp);
      expect(
        failure(yield* Effect.exit(exec(single, ["--valu", "x"])))
      ).toBeInstanceOf(CliError.ShowHelp);
      expect(log).toStrictEqual([]);

      expect(yield* lines(cli, ["write", "--value", "x"])).toStrictEqual([
        '"alice wrote x to db"',
      ]);
      expect(log).toStrictEqual(["read caller", "connect", "disconnect"]);

      expect(failure(yield* Effect.exit(exec(cli, [])))).toBeInstanceOf(
        CliError.ShowHelp
      );
      expect(log).toStrictEqual([
        "read caller",
        "connect",
        "disconnect",
        "read caller",
        "connect",
        "disconnect",
      ]);
    })
);

const subprocessCompilingTypeScriptTimeout = 30_000;

const runUsersCli = (...args: readonly string[]) =>
  spawnSync(
    process.execPath,
    ["--import", "tsx", "tests/support/app/cli.ts", ...args],
    {
      cwd: process.cwd(),
      encoding: "utf-8",
      env: { ...process.env, FORCE_COLOR: "" },
    }
  );

const exitCodeOf = <A, E>(exit: Exit.Exit<A, E>) =>
  Exit.isFailure(exit) ? Runtime.getErrorExitCode(Cause.squash(exit.cause)) : 0;

const reportedByRunMainOf = <A, E>(exit: Exit.Exit<A, E>) =>
  Exit.isFailure(exit) && Runtime.getErrorReported(Cause.squash(exit.cause));

describe("a command run by Effect's runner", () => {
  it(
    "runs under Effect's own runner: the result on stdout, a failure's JSON once on stderr, and its exit code",
    () => {
      const found = runUsersCli("get-user", "--id", "1");

      expect(found.status).toBe(0);
      expect(JSON.parse(found.stdout)).toStrictEqual({ id: "1", name: "Ada" });
      expect(found.stderr).toBe("");

      const missing = runUsersCli("get-user", "--id", "9");

      expect(missing.status).toBe(1);
      expect(missing.stdout).toBe("");
      expect(missing.stderr.trim().split("\n").at(-1)?.trim()).toBe(
        '{"_tag":"UserNotFound","id":"9"}'
      );
      expect(missing.stderr.match(/UserNotFound/gu)).toHaveLength(1);

      const invalid = runUsersCli("rename-user", "--id", "1", "--name", "");

      expect(invalid.status).toBe(1);
      expect(invalid.stdout).toBe("");
      expect(invalid.stderr).toContain('{"_tag":"InvalidInput"');

      const help = runUsersCli("--help");

      expect(help.status).toBe(0);
      expect(help.stdout).toContain("rename-user");
      expect(help.stderr).toBe("");
    },
    subprocessCompilingTypeScriptTimeout
  );

  it.effect(
    "matches a failure by its tag with Effect's own catchReason, after Command.run",
    () =>
      Effect.gen(function* () {
        class Missing extends Schema.TaggedError<
          Missing,
          { readonly brand: unique symbol }
        >()("Missing", {
          id: Schema.String,
        }) {}

        const Find = Action.make("find", {
          description: "Find",
          readOnly: true,
          caller: Action.Anyone,
          input: { id: Schema.String },
          error: [Missing],
        });

        const find = ActionCli.command(
          Action.implement(Find, ({ id }) => Effect.fail(new Missing({ id }))),
          Find
        );

        const recovered = yield* exec(find, ["--id", "9"]).pipe(
          Effect.catchReason("UserError", "Missing", ({ id }) =>
            Effect.succeed(`missing ${id}`)
          )
        );

        expect(recovered).toBe("missing 9");
      })
  );

  it.effect(
    "reports on stderr what runMain would report, once, and keeps its exit code under logToStderr",
    () =>
      Effect.gen(function* () {
        const {
          exit: defect,
          stdout: defectOut,
          stderr: defectErr,
        } = yield* printed(
          ActionCli.logToStderr(
            Effect.log("connecting").pipe(Effect.andThen(Effect.die("bug")))
          )
        );

        expect(defectOut).toStrictEqual([]);
        expect(defectErr.join("\n")).toContain("connecting");
        expect(defectErr.join("\n")).toContain("bug");
        expect(reportedByRunMainOf(defect)).toBe(false);
        expect(exitCodeOf(defect)).toBe(1);

        assert(Exit.isFailure(defect));
        const report = Cause.squash(defect.cause);
        assert(report instanceof Error && Cause.isCause(report.cause));
        expect(Cause.squash(report.cause)).toBe("bug");

        class Exiting extends Schema.TaggedError<
          Exiting,
          { readonly brand: unique symbol }
        >()("Exiting", {}) {
          override readonly [Runtime.errorExitCode] = 3;
        }

        const Quit = Action.make("quit", {
          description: "Quit",
          readOnly: true,
          caller: Action.Anyone,
          error: [Exiting],
        });

        const quit = ActionCli.command(
          Action.implement(Quit, () => Effect.fail(new Exiting())),
          Quit
        );

        const {
          exit: failed,
          stdout: failedOut,
          stderr: failedErr,
        } = yield* printed(ActionCli.logToStderr(exec(quit, [])));

        expect(failedOut).toStrictEqual([]);
        expect(failedErr.join("\n").match(/Exiting/gu)).toHaveLength(1);
        expect(exitCodeOf(failed)).toBe(3);

        const interrupted = yield* Effect.exit(
          ActionCli.logToStderr(Effect.interrupt)
        );

        assert(Exit.isFailure(interrupted));
        expect(Cause.hasInterruptsOnly(interrupted.cause)).toBe(true);
      })
  );

  it.effect(
    "reports a failing host layer and its logs on stderr under logToStderr",
    () =>
      Effect.gen(function* () {
        class Unreachable extends Data.TaggedError("Unreachable") {}

        class Database extends Context.Service<Database, string>()(
          "cli-test/Database"
        ) {}

        const failing = Layer.effect(
          Database,
          Effect.log("connecting").pipe(
            Effect.andThen(Effect.fail(new Unreachable()))
          )
        );

        const dying = Layer.effect(
          Database,
          Effect.log("connecting").pipe(
            Effect.andThen(Effect.die(new Error("no driver")))
          )
        );

        const Ping = Action.make("ping", {
          description: "Ping",
          readOnly: true,
          caller: Action.Anyone,
          success: Schema.String,
        });

        const ping = ActionCli.command(
          Action.implement(Ping, () =>
            Effect.map(Database, (name) => `pong from ${name}`)
          ),
          Ping
        );

        const runs = [
          [
            ActionCli.logToStderr(
              exec(ping.pipe(Command.provide(failing)), [])
            ),
            /Unreachable/gu,
          ],
          [
            ActionCli.logToStderr(exec(ping, []).pipe(Effect.provide(dying))),
            /no driver/gu,
          ],
        ] as const;

        for (const [run, report] of runs) {
          const { exit, stdout, stderr } = yield* printed(run);

          expect(stdout).toStrictEqual([]);
          expect(stderr.join("\n")).toContain("connecting");
          expect(stderr.join("\n").match(report)).toHaveLength(1);
          expect(reportedByRunMainOf(exit)).toBe(false);
          expect(exitCodeOf(exit)).toBe(1);
        }
      })
  );
});

it.effect(
  "runs a public command of a mixed implementation without its siblings' authorization",
  () =>
    Effect.gen(function* () {
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
        {
          open: () => Effect.succeed("open"),
          guarded: () => Effect.succeed("guarded"),
        },
        { authorize: Effect.as(Boot, Action.allowAll) }
      );

      const { exit: result, stdout: output } = yield* printed(
        exec(ActionCli.command(app, Open), [])
      );

      expect([Exit.isSuccess(result), output]).toStrictEqual([
        true,
        ['"open"'],
      ]);
    })
);

it.effect(
  "gives a positional field no flag, and a piped withSubcommands only its own subcommands",
  () =>
    Effect.gen(function* () {
      const Note = Action.make("note", {
        description: "Keep a note",
        readOnly: false,
        caller: Action.Anyone,
        input: { text: Schema.String },
        success: Schema.String,
      });

      const app = Action.implement(Note, ({ text }) => Effect.succeed(text));
      const command = ActionCli.command(app, Note, { positional: ["text"] });

      expect(yield* lines(command, ["hi"])).toStrictEqual(['"hi"']);

      const flagged = failure(
        yield* Effect.exit(exec(command, ["--text", "hi"]))
      );

      expect(flagged).toBeInstanceOf(CliError.ShowHelp);

      if (flagged instanceof CliError.ShowHelp) {
        expect(flagged.errors[0]).toBeInstanceOf(CliError.UnrecognizedOption);
      }

      const piped = ActionCli.make(app, { name: "notes" }).pipe(
        Command.withSubcommands([Command.make("own")])
      );

      expect(
        yield* lines(ActionCli.make(app, { name: "notes" }), [
          "note",
          "--text",
          "hi",
        ])
      ).toStrictEqual(['"hi"']);

      const replaced = failure(
        yield* Effect.exit(exec(piped, ["note", "--text", "hi"]))
      );

      expect(replaced).toBeInstanceOf(CliError.ShowHelp);

      if (replaced instanceof CliError.ShowHelp) {
        expect(replaced.errors[0]).toBeInstanceOf(CliError.UnknownSubcommand);
      }
    })
);
