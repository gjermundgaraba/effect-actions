// Compile-only public CLI API assertions.
import { Context, Effect, Schema } from "effect";
import { HttpClient, type HttpClientError } from "effect/http";
import { Command } from "effect/cli";
import { expectTypeOf } from "@effect/vitest";
import * as Action from "../src/Action.js";
import * as ActionCli from "../src/ActionCli.js";
import * as ActionHttp from "../src/ActionHttp.js";

class Build extends Context.Service<Build, string>()("cli-types/Build") {}

class OneRequest extends Context.Service<OneRequest, string>()("cli-types/OneRequest") {}

class TwoRequest extends Context.Service<TwoRequest, number>()("cli-types/TwoRequest") {}

class Hooked extends Context.Service<Hooked, string>()("cli-types/Hooked") {}

const One = Action.make("one", {
  description: "One",
  access: "write",
  input: Schema.Struct({ value: Schema.String }),
  success: Schema.String,
});

const Two = Action.make("two", {
  description: "Two",
  access: "write",
  input: Schema.Struct({ value: Schema.Finite }),
  success: Schema.Finite,
});

const local = Action.implement(
  [One, Two],
  Effect.map(Build, (prefix) => ({
    one: ({ value }: { value: string }) =>
      Effect.map(OneRequest, (request) => `${prefix}${request}${value}`),
    two: ({ value }: { value: number }) => Effect.map(TwoRequest, (request) => value + request),
  })),
  Action.allowAll,
);

const localOne = ActionCli.command(local, One, {
  render: (output) => output.toUpperCase(),
});

const localTwo = ActionCli.command(local, Two, {
  render: (output) => String(output.toFixed()),
});

const localGroup = ActionCli.make(local, { name: "local" });

// Each command owes exactly its action's services and the builder's.
expectTypeOf<Command.Services<typeof localOne>>().toEqualTypeOf<Build | OneRequest>();

expectTypeOf<Command.Services<typeof localTwo>>().toEqualTypeOf<Build | TwoRequest>();

expectTypeOf<Command.Services<typeof localGroup>>().toEqualTypeOf<
  Build | OneRequest | TwoRequest
>();

// Any implementation may refuse, and any handler fail with a built-in error: every local
// command fails with `BuiltIn`, beside the action's own failures, whatever its hook.
const refuse = Effect.fn(function* (action: Action.Any) {
  yield* Hooked;

  if (action.access === "write") return yield* new Action.Unauthenticated();

  return yield* new Action.Forbidden();
});

const refusing = ActionCli.command(
  Action.implement(One, ({ value }) => Effect.succeed(value), refuse),
  One,
  { render: (output) => output.toUpperCase() },
);

// A command fails with Effect CLI's UserError, its cause the action's failure or a built-in
// one: invalid input included, and no schema error of its own.
expectTypeOf<Command.Error<typeof localOne>>().toEqualTypeOf<ActionCli.Failure<Action.BuiltIn>>();

expectTypeOf<Command.Error<typeof localGroup>>().toEqualTypeOf<ActionCli.Failure<Action.BuiltIn>>();

expectTypeOf<Command.Error<typeof refusing>>().toEqualTypeOf<ActionCli.Failure<Action.BuiltIn>>();

// The hook's services are the command's too.
expectTypeOf<Command.Services<typeof refusing>>().toEqualTypeOf<Hooked>();

const Plain = Action.make("plain", {
  description: "Plain",
  access: "write",
  success: Schema.String,
});

const noService = Action.implement(Plain, () => Effect.succeed("plain"), Action.allowAll);

const plainCommand = ActionCli.command(noService, Plain);

const plainGroup = ActionCli.make(noService, { name: "plain" });

expectTypeOf<Command.Services<typeof plainCommand>>().toBeNever();

expectTypeOf<Command.Services<typeof plainGroup>>().toBeNever();

// An implementation written inside the list owes nothing, as every surface's list keeps it:
// inferring from the list's erased element would make it owe `unknown`.
const inlineGroup = ActionCli.make(
  [local, Action.implement(Plain, () => Effect.succeed("plain"), Action.allowAll)],
  { name: "inline" },
);

expectTypeOf<Command.Services<typeof inlineGroup>>().toEqualTypeOf<
  Build | OneRequest | TwoRequest
>();

// TypeScript reports a call no overload matches by the last overload's error alone, so the
// last, for `make` as for `command`, takes a binding or implementations and is reached only
// when both precise forms fail: a mistake in either form is named, such as a misspelled
// `commands` key, `Did you mean to write 'one'?`, rather than reported against the other form.
expectTypeOf<Parameters<typeof ActionCli.make>[0]>().toEqualTypeOf<
  ActionHttp.Any | Action.AnyImplementation | ReadonlyArray<Action.AnyImplementation>
>();

expectTypeOf<Parameters<typeof ActionCli.command>[0]>().toEqualTypeOf<
  ActionHttp.Any | Action.AnyImplementation | ReadonlyArray<Action.AnyImplementation>
>();

const Scoped = Action.make("scoped", {
  description: "Scoped",
  access: "write",
  success: Schema.String,
});

const scoped = Action.implement(
  [Scoped],
  Effect.acquireRelease(
    Effect.succeed({ scoped: () => Effect.succeed("scoped") }),
    () => Effect.void,
  ),
  Action.allowAll,
);

const scopedCommand = ActionCli.command(scoped, Scoped);

const scopedGroup = ActionCli.make(scoped, { name: "scoped" });

// A builder's scope is the command's own, not a service it owes.
expectTypeOf<Command.Services<typeof scopedCommand>>().toBeNever();

expectTypeOf<Command.Services<typeof scopedGroup>>().toBeNever();

const ScopedHandler = Action.make("scopedHandler", {
  description: "Scoped handler",
  access: "write",
  success: Schema.String,
});

const scopedHandler = Action.implement(
  ScopedHandler,
  () => Effect.acquireRelease(Effect.succeed("scoped handler"), () => Effect.void),
  Action.allowAll,
);

const scopedHandlerCommand = ActionCli.command(scopedHandler, ScopedHandler);

const scopedHandlerGroup = ActionCli.make(scopedHandler, { name: "scoped-handler" });

// So is a handler's.
expectTypeOf<Command.Services<typeof scopedHandlerCommand>>().toBeNever();

expectTypeOf<Command.Services<typeof scopedHandlerGroup>>().toBeNever();

// @ts-expect-error A local command selects an action implemented by `apps`.
ActionCli.command(local, Plain);

// @ts-expect-error The renderer receives the selected action's exact success value.
ActionCli.command(local, Two, { render: (output: string) => output });

class Domain extends Schema.TaggedError<Domain>()("Domain", {}) {}

const RemoteAction = Action.make("remote", {
  description: "Remote",
  access: "write",
  input: Schema.Struct({ value: Schema.String }),
  success: Schema.String,
  errors: [Domain],
});

const Count = Action.make("count", {
  description: "Count",
  access: "write",
  success: Schema.Finite,
});

const Other = Action.make("other", {
  description: "Other",
  access: "write",
  success: Schema.String,
});

const http = ActionHttp.make([RemoteAction, Count, Other]);

const remote = ActionCli.command(http, RemoteAction, {
  render: (output) => output.toUpperCase(),
});

const remoteCount = ActionCli.command(http, Count, {
  render: (output) => String(output.toFixed()),
});

const remoteGroup = ActionCli.make(http, { name: "remote" });

// A remote command owes only the client; its failures are checked below.
expectTypeOf<Command.Services<typeof remote>>().toEqualTypeOf<HttpClient.HttpClient>();

expectTypeOf<Command.Services<typeof remoteGroup>>().toEqualTypeOf<HttpClient.HttpClient>();

void remoteCount;

void remoteGroup;

// @ts-expect-error A remote command selects an action of the binding.
ActionCli.command(http, Plain);

// A command from a binding fails with exactly what its client method fails with: the
// action's own errors, the built-in errors every endpoint declares, and the native
// transport and schema failures.
class Gone extends Schema.TaggedError<Gone>()("Gone", {}, { httpApiStatus: 410 }) {}

const Erring = Action.make("erring", {
  description: "Declares an error",
  access: "read",
  success: Schema.String,
  errors: [Gone],
});

const Bound = ActionHttp.make([Plain, Erring]);

type Transport = HttpClientError.HttpClientError | Schema.SchemaError;

const boundPlain = ActionCli.command(Bound, Plain);

const boundErring = ActionCli.command(Bound, Erring);

const boundAll = ActionCli.make(Bound, { name: "remote" });

expectTypeOf<Command.Error<typeof boundPlain>>().toEqualTypeOf<
  ActionCli.Failure<Action.BuiltIn | Transport>
>();

expectTypeOf<Command.Error<typeof boundErring>>().toEqualTypeOf<
  ActionCli.Failure<Gone | Action.BuiltIn | Transport>
>();

expectTypeOf<Command.Error<typeof boundAll>>().toEqualTypeOf<
  ActionCli.Failure<Gone | Action.BuiltIn | Transport>
>();

// A binding's own errors are every remote command's failures too.
class Throttled extends Schema.TaggedError<Throttled>()("Throttled", {}, { httpApiStatus: 429 }) {}

const Throttling = ActionHttp.make([Plain, Erring], { errors: [Throttled] });

const throttledPlain = ActionCli.command(Throttling, Plain);

const throttledAll = ActionCli.make(Throttling, { name: "remote" });

expectTypeOf<Command.Error<typeof throttledPlain>>().toEqualTypeOf<
  ActionCli.Failure<Throttled | Action.BuiltIn | Transport>
>();

expectTypeOf<Command.Error<typeof throttledAll>>().toEqualTypeOf<
  ActionCli.Failure<Throttled | Gone | Action.BuiltIn | Transport>
>();

// @ts-expect-error An aggregate remote command needs a name.
ActionCli.make(Bound, {});

// The options exported for each function, the same locally and over HTTP.
const commandOptions: ActionCli.CommandOptions<typeof RemoteAction> = {
  render: (output) => output,
};

const makeOptions: ActionCli.Options<typeof RemoteAction> = {
  name: "r",
  commands: { remote: { positional: ["value"], render: (output) => output.toUpperCase() } },
};

ActionCli.command(http, RemoteAction, commandOptions);

ActionCli.make(http, makeOptions);

// A subcommand's options are typed by its own action.
ActionCli.make(http, { name: "r", commands: { count: { render: (output) => output.toFixed() } } });

ActionCli.make(local, { name: "l", commands: { one: { positional: ["value"] } } });

// @ts-expect-error A subcommand's renderer receives its own action's success.
ActionCli.make(http, { name: "r", commands: { count: { render: (output: string) => output } } });

// @ts-expect-error No action is named so.
ActionCli.make(http, { name: "r", commands: { missing: {} } });

// Positional arguments name a struct input's own fields, locally and over HTTP.
ActionCli.command(local, One, { positional: ["value"] });

ActionCli.command(http, RemoteAction, { positional: ["value"] });

// @ts-expect-error Not a field of the input.
ActionCli.command(local, One, { positional: ["other"] });

const ScalarInput = Action.make("scalarInput", {
  description: "A scalar input",
  access: "read",
  input: Schema.String,
});

const UnionInput = Action.make("unionInput", {
  description: "A union input",
  access: "read",
  input: Schema.Union([Schema.Struct({ a: Schema.String }), Schema.Struct({ a: Schema.Finite })]),
});

const shapes = Action.implement(
  [ScalarInput, UnionInput, Other],
  {
    scalarInput: () => Effect.void,
    unionInput: () => Effect.void,
    other: () => Effect.succeed("other"),
  },
  Action.allowAll,
);

// Only named fields of one struct may be positional: none for a scalar, a union or no input.
expectTypeOf<ActionCli.CommandOptions<typeof ScalarInput>["positional"]>().toEqualTypeOf<
  ReadonlyArray<never> | undefined
>();

expectTypeOf<ActionCli.CommandOptions<typeof Other>["positional"]>().toEqualTypeOf<
  ReadonlyArray<never> | undefined
>();

// @ts-expect-error A union input has no positional fields, even shared ones.
ActionCli.command(shapes, UnionInput, { positional: ["a"] });

// A local command's cause is what its action, hook or builder fails with, or a built-in one.
class Unavailable extends Schema.TaggedError<Unavailable>()("Unavailable", {}) {}

const Declares = Action.make("declares", {
  description: "Declares an error",
  access: "read",
  success: Schema.String,
  errors: [Domain],
});

const declares = ActionCli.command(
  Action.implement(
    Declares,
    Effect.as(Effect.fail(new Unavailable()), () => Effect.succeed("declared")),
    Action.allowAll,
  ),
  Declares,
);

expectTypeOf<Command.Error<typeof declares>>().toEqualTypeOf<
  ActionCli.Failure<Domain | Unavailable | Action.BuiltIn>
>();

// Run, a command may fail with any `UserError`, so a host matches the cause itself.
Command.runWith(declares, { version: "0" })([]).pipe(
  Effect.catchTag("UserError", (error) => {
    expectTypeOf<typeof error.cause>().toBeUnknown();

    return error.cause instanceof Domain ? Effect.succeed(error.cause._tag) : Effect.fail(error);
  }),
);

const matched = (error: Command.Error<typeof declares>) =>
  // @ts-expect-error `Failure` is a type only: `instanceof` would leave its cause `any`.
  error instanceof ActionCli.Failure;

void matched;
