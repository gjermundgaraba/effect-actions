import { expect, it, vi } from "vite-plus/test";
import { Cause, Effect, Exit, Option, Schema, type Scope } from "effect";
import { CliError, Command, Flag, GlobalFlag } from "effect/unstable/cli";
import * as Action from "../src/Action.js";
import * as ActionCli from "../src/ActionCli.js";
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
  Effect.runPromiseExit(
    Effect.scoped(
      Command.runWith(command, { version: "0" })(args).pipe(Effect.provide(cliServices)),
    ),
  );

/** Every line a successful run logs. */
const lines = <Name extends string, Input, Context, E>(
  command: Command.Command<Name, Input, Context, E, Scope.Scope>,
  args: ReadonlyArray<string>,
) =>
  Effect.runPromise(
    Effect.scoped(
      logged(Command.runWith(command, { version: "0" })(args)).pipe(Effect.provide(cliServices)),
    ),
  ).then(([, output]) => output);

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

  const app = Action.implement(Flags, (input) =>
    Effect.andThen(
      Effect.sync(() => inputs.push(input)),
      () => Effect.succeed("ok"),
    ),
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

  // A choice, a number and a JSON flag are parsed natively: a bad value shows help.
  for (const args of [
    ["--tenant-id", "acme", "--count", "1", "--mode", "slow", "--tags", "[]", "--owner", "{}"],
    ["--tenant-id", "acme", "--count", "many", "--mode", "fast", "--tags", "[]"],
    ["--tenant-id", "acme", "--tags", "[", ...required],
  ]) {
    const error = failure(await runExit(command, args));
    expect(error).toBeInstanceOf(CliError.ShowHelp);

    if (error instanceof CliError.ShowHelp) {
      expect(error.errors[0]).toBeInstanceOf(CliError.InvalidValue);
    }
  }

  // The action's schema, not the parser, decides what is required.
  const missing = failure(await runExit(command, ["--tags", "[]", ...required]));
  expect(missing).toBeInstanceOf(Schema.SchemaError);
  expect(String(missing)).toContain("Missing key");
  expect(String(missing)).toContain("tenantId");

  // A JSON flag holding JSON of the wrong shape is invalid input as well.
  expect(
    failure(await runExit(command, ["--tenant-id", "acme", "--tags", "[1]", ...required])),
  ).toBeInstanceOf(Schema.SchemaError);

  expect(inputs).toHaveLength(2);
});

it("maps flag strings to codecs whose original encoding is not JSON", async () => {
  const inputs: Date[] = [];

  const Dated = Action.make("dated", {
    description: "Receives a decoded date",
    access: "write",
    input: Schema.Struct({ at: Schema.Date }),
    success: Schema.String,
  });

  const app = Action.implement([Dated], {
    dated: ({ at }) =>
      Effect.andThen(
        Effect.sync(() => inputs.push(at)),
        () => Effect.succeed(at.toISOString()),
      ),
  });

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
  );

  const command = ActionCli.command(app, NumberAction);

  expect(failure(await runExit(command, ["--value", "not-a-number"]))).toBeInstanceOf(
    Schema.SchemaError,
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

  const app = Action.implement([Scalar, Shape, Scores], {
    scalar: record,
    shape: record,
    scores: record,
  });

  await run(ActionCli.command(app, Scalar), ["--input", '"text"']);
  await run(ActionCli.command(app, Shape), ["--input", '{"kind":"square","side":2}']);
  await run(ActionCli.command(app, Scores), ["--input", '{"a":1,"b":2}']);

  const malformed = failure(await runExit(ActionCli.command(app, Shape), ["--input", "{"]));
  expect(malformed).toBeInstanceOf(CliError.ShowHelp);

  if (malformed instanceof CliError.ShowHelp) {
    expect(malformed.errors[0]).toBeInstanceOf(CliError.InvalidValue);
  }

  // No field of a union member is a flag of its own.
  expect(
    failure(await runExit(ActionCli.command(app, Shape), ["--kind", "square", "--side", "2"])),
  ).toBeInstanceOf(CliError.ShowHelp);
  // Omitted, the input is `{}`, which the schema rejects.
  expect(failure(await runExit(ActionCli.command(app, Shape), []))).toBeInstanceOf(
    Schema.SchemaError,
  );

  expect(values).toEqual(["text", { kind: "square", side: 2 }, { a: 1, b: 2 }]);
});

it("keeps custom renderer JSON output and validates success before rendering", async () => {
  let rendered = 0;

  const Rendered = Action.make("rendered", {
    description: "Renders",
    access: "write",
    success: Schema.String,
  });

  const app = Action.implement([Rendered], {
    rendered: () => Effect.succeed("value"),
  });

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

  const invalid = Action.implement([Invalid], {
    invalid: () => Effect.succeed(Infinity),
  });

  expect(
    Exit.isFailure(
      await runExit(ActionCli.command(invalid, Invalid, { render: invalidRenderer }), []),
    ),
  ).toBe(true);
  expect(invalidRenderer).not.toHaveBeenCalled();
});

it("keeps an input field's flags apart from the renderer's --json", async () => {
  const inputs: string[] = [];

  const Configured = Action.make("configured", {
    description: "A field whose flag is not the renderer's",
    access: "write",
    input: Schema.Struct({ payloadJson: Schema.String }),
    success: Schema.String,
  });

  const app = Action.implement([Configured], {
    configured: ({ payloadJson }) =>
      Effect.andThen(
        Effect.sync(() => inputs.push(payloadJson)),
        () => Effect.succeed(payloadJson),
      ),
  });

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

  const app = Action.implement(Read, (lookup) =>
    Effect.succeed(`${lookup.userId} ${lookup.attempts} ${lookup instanceof Lookup}`),
  );

  const command = ActionCli.command(app, Read);

  expect(await lines(command, ["--user-id", "u1", "--attempts", "2"])).toEqual(['"u1 2 true"']);

  // Encoding drops a transformed field's description; the flag keeps the declared one.
  const help = (await lines(command, ["--help"])).join("\n");
  expect(help).toMatch(/--user-id string\s+Whose record to read/);
  expect(help).toMatch(/--attempts number\s+How many times to try/);
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
    Action.implement(Search, (input) => Effect.succeed(JSON.stringify(input))),
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
  expect(help).toMatch(/--limit number\s+How many to return/);
  expect(help).toMatch(/--exact\s+Match whole words/);
});

it("gives a number beside other strings a JSON flag, so the strings stay reachable", async () => {
  const Page = Action.make("page", {
    description: "Reads a page",
    access: "read",
    input: { limit: Schema.Union([Schema.Finite, Schema.Literal("auto")]) },
    success: Schema.String,
  });

  const command = ActionCli.command(
    Action.implement(Page, ({ limit }) => Effect.succeed(String(limit))),
    Page,
  );

  expect(await lines(command, ["--limit", "3"])).toEqual(['"3"']);
  expect(await lines(command, ["--limit", '"auto"'])).toEqual(['"auto"']);
  expect((await lines(command, ["--help"])).join("\n")).toMatch(/--limit json/);
});

it("lets a field shadow a global flag, and leaves a clash within a command to the parser", async () => {
  const Settings = Action.make("settings", {
    description: "Has fields named like global flags and like the renderer's flag",
    access: "read",
    input: { help: Schema.String, logLevel: Schema.String, json: Schema.String },
    success: Schema.String,
  });

  const app = Action.implement(Settings, ({ help, logLevel, json }) =>
    Effect.succeed(`${help} ${logLevel} ${json}`),
  );

  const args = ["--help", "a", "--log-level", "b", "--json", "c"];

  // A field's flag wins over the global flag of the same name.
  expect(await lines(ActionCli.command(app, Settings), args)).toEqual(['"a b c"']);

  // Beside a renderer's own `--json`, the native parser refuses the command on every run.
  const rendered = await runExit(ActionCli.command(app, Settings, { render: String }), args);

  expect(Exit.isFailure(rendered) && Cause.pretty(rendered.cause)).toContain(
    'Duplicate flag name "json" in command definition',
  );

  // So it does two fields of one kebab-case name.
  const Twice = Action.make("twice", {
    description: "Names one field twice",
    access: "read",
    input: { userId: Schema.String, user_id: Schema.String },
    success: Schema.String,
  });

  const twice = await runExit(
    ActionCli.command(
      Action.implement(Twice, () => Effect.succeed("")),
      Twice,
    ),
    [],
  );

  expect(Exit.isFailure(twice) && Cause.pretty(twice.cause)).toContain(
    'Duplicate flag name "user-id" in command definition',
  );
});

it("runs any action locally, scopes every invocation, and exposes aggregate subcommands", async () => {
  let acquired = 0;
  let released = 0;
  const inputs: string[] = [];

  // Bound to no HTTP or MCP adapter: the CLI still runs it.
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
  );

  await run(ActionCli.command(app, Local), ["--value", "direct"]);
  await run(ActionCli.make(app, { name: "locals" }), ["local", "--value", "group"]);

  expect(inputs).toEqual(["direct", "group"]);
  expect(acquired).toBe(2);
  expect(released).toBe(2);
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

  const app = Action.implement([Plain, Pretty], {
    plain: () => Effect.succeed("plain"),
    pretty: () => Effect.succeed("pretty"),
  });

  const pretty = ActionCli.command(app, Pretty, { render: (value) => `rendered ${value}` });
  expect(await lines(pretty, [])).toEqual(["rendered pretty"]);
  expect(await lines(pretty, ["--json"])).toEqual(['"pretty"']);
  // Without a renderer the output is JSON already, and the flag does not exist:
  // the native parser treats it as unknown and shows help.
  expect(await lines(ActionCli.command(app, Plain), [])).toEqual(['"plain"']);
  await expect(lines(ActionCli.command(app, Plain), ["--json"])).rejects.toThrow("Help requested");

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

  const first = Action.implement(First, () => Effect.succeed("first"));
  const second = Action.implement(Second, () => Effect.succeed("second"));

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

  const one = Action.implement(One, () => Effect.succeed("one"));
  const two = Action.implement(Two, () => Effect.succeed("two"));

  const tool = ActionCli.make([one, two], { name: "tool" });
  expect(tool.name).toBe("tool");

  expect(await lines(tool, ["two"])).toEqual(['"two"']);

  const Again = Action.make("one", {
    description: "Again",
    access: "read",
    success: Schema.String,
  });

  const again = Action.implement(Again, () => Effect.succeed("again"));

  expect(() => ActionCli.make([one, again], { name: "tool" })).toThrow("Duplicate command: one");
});

it("names commands and flags in kebab case, unless a name is given", async () => {
  const users: string[] = [];

  const GetUser = Action.make("getUser", {
    description: "Reads a user",
    access: "read",
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

  const snake = Action.implement(Snake, () => Effect.succeed("snake"));

  expect(() => ActionCli.make([app, snake], { name: "users" })).toThrow(
    "Duplicate command: get-user",
  );
});

it("runs the before hook first, and its refusal is the command's typed failure", async () => {
  const seen: string[] = [];
  let calls = 0;

  const Read = Action.make("read", { description: "Read", access: "read", success: Schema.String });

  const Write = Action.make("write", {
    description: "Write",
    access: "write",
    success: Schema.String,
  });

  const app = Action.implement([Read, Write], {
    read: () => Effect.sync(() => `read ${++calls}`),
    write: () => Effect.sync(() => `write ${++calls}`),
  });

  const before = (action: Action.Any) =>
    Effect.andThen(
      Effect.sync(() => seen.push(action.name)),
      () =>
        action.access === "read"
          ? Effect.void
          : Effect.fail(new Action.Forbidden({ message: "Requires users:write." })),
    );

  await run(ActionCli.command(app, Read, { before }), []);

  const refused = failure(await runExit(ActionCli.command(app, Write, { before }), []));
  expect(refused).toBeInstanceOf(Action.Forbidden);
  expect(refused).toEqual(new Action.Forbidden({ message: "Requires users:write." }));

  const aggregate = ActionCli.make(app, { name: "tool", before });
  await run(aggregate, ["read"]);
  expect(failure(await runExit(aggregate, ["write"]))).toBeInstanceOf(Action.Forbidden);

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
  );

  const idle = Action.implement(
    Idle,
    Effect.sync(() => {
      builds.push("idle");

      return () => Effect.succeed("idle");
    }),
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
