// Compile-only public CLI API assertions.
import { Context, Effect, Schema } from "effect";
import { HttpClient, type HttpClientError } from "effect/unstable/http";
import type { Command } from "effect/unstable/cli";
import * as Action from "../src/Action.js";
import * as ActionCli from "../src/ActionCli.js";
import * as ActionHttp from "../src/ActionHttp.js";
import type { Equal } from "./equal.js";

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
);

const localOne = ActionCli.command(local, One, {
  render: (output) => output.toUpperCase(),
});

const localTwo = ActionCli.command(local, Two, {
  render: (output) => String(output.toFixed()),
});

const localGroup = ActionCli.make(local, { name: "local" });

// Each command owes exactly its action's services and the builder's.
const localServices: [
  Equal<Command.Services<typeof localOne>, Build | OneRequest>,
  Equal<Command.Services<typeof localTwo>, Build | TwoRequest>,
  Equal<Command.Services<typeof localGroup>, Build | OneRequest | TwoRequest>,
] = [true, true, true];

// Any implementation may refuse: every local command fails with `Refusal`, beside the
// action's own failures and invalid input, whatever its hook.
const forbid = () => Effect.fail(new Action.Forbidden());

const forbidding = Action.implement(One, ({ value }) => Effect.succeed(value), forbid);

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

// Failures are the action's, the implementation hook's and the CLI's own encoding error.
const refusalErrors: [
  Equal<Command.Error<typeof localOne>, Action.Refusal | Schema.SchemaError>,
  Equal<Command.Error<typeof localGroup>, Action.Refusal | Schema.SchemaError>,
  Equal<Command.Error<typeof refusing>, Action.Refusal | Schema.SchemaError>,
] = [true, true, true];

// The hook's services are the command's too.
const refusingHooked: Equal<Command.Services<typeof refusing>, Hooked> = true;

// @ts-expect-error A contract it does not implement is refused.
ActionCli.command(forbidding, Two);

void localServices;

void refusalErrors;

void refusingHooked;

const Plain = Action.make("plain", {
  description: "Plain",
  access: "write",
  success: Schema.String,
});

const noService = Action.implement(Plain, () => Effect.succeed("plain"));

const plainCommand = ActionCli.command(noService, Plain);

const plainGroup = ActionCli.make(noService, { name: "plain" });

const plainServices: [
  Equal<Command.Services<typeof plainCommand>, never>,
  Equal<Command.Services<typeof plainGroup>, never>,
] = [true, true];

void plainServices;

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
);

const scopedCommand = ActionCli.command(scoped, Scoped);

const scopedGroup = ActionCli.make(scoped, { name: "scoped" });

// A builder's scope is the command's own, not a service it owes.
const scopedServices: [
  Equal<Command.Services<typeof scopedCommand>, never>,
  Equal<Command.Services<typeof scopedGroup>, never>,
] = [true, true];

void scopedServices;

const ScopedHandler = Action.make("scopedHandler", {
  description: "Scoped handler",
  access: "write",
  success: Schema.String,
});

const scopedHandler = Action.implement(ScopedHandler, () =>
  Effect.acquireRelease(Effect.succeed("scoped handler"), () => Effect.void),
);

const scopedHandlerCommand = ActionCli.command(scopedHandler, ScopedHandler);

const scopedHandlerGroup = ActionCli.make(scopedHandler, { name: "scoped-handler" });

// So is a handler's.
const scopedHandlerServices: [
  Equal<Command.Services<typeof scopedHandlerCommand>, never>,
  Equal<Command.Services<typeof scopedHandlerGroup>, never>,
] = [true, true];

void scopedHandlerServices;

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
const remoteServices: [
  Equal<Command.Services<typeof remote>, HttpClient.HttpClient>,
  Equal<Command.Services<typeof remoteGroup>, HttpClient.HttpClient>,
] = [true, true];

void remoteServices;

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

type BuiltIn = Action.InvalidInput | Action.Refusal;

type Transport = HttpClientError.HttpClientError | Schema.SchemaError;

const boundPlain = ActionCli.command(Bound, Plain);

const boundErring = ActionCli.command(Bound, Erring);

const boundAll = ActionCli.make(Bound, { name: "remote" });

const remoteErrors: [
  Equal<Command.Error<typeof boundPlain>, BuiltIn | Transport>,
  Equal<Command.Error<typeof boundErring>, Gone | BuiltIn | Transport>,
  Equal<Command.Error<typeof boundAll>, Gone | BuiltIn | Transport>,
] = [true, true, true];

void remoteErrors;

const transformResponse = <A, E, R>(effect: Effect.Effect<A, E, R>) => effect;

// `transformResponse` could change a call's failures, which the command's type states.
// @ts-expect-error The command takes the client's options, which exclude it.
ActionCli.command(Bound, Plain, { transformResponse });

// @ts-expect-error The aggregate excludes it too.
ActionCli.make(Bound, { name: "r", transformResponse });

// @ts-expect-error An aggregate remote command needs a name.
ActionCli.make(Bound, {});

// Client options are a remote command's only; a local command runs no client.
ActionCli.command(Bound, Plain, { baseUrl: "http://localhost" });

ActionCli.make(Bound, { name: "r", baseUrl: "http://localhost" });

// @ts-expect-error A local command takes no client options.
ActionCli.command(local, One, { baseUrl: "http://localhost" });

// @ts-expect-error A local aggregate takes none either.
ActionCli.make(local, { name: "l", baseUrl: "http://localhost" });

// The options exported for each function, joined with the client's over HTTP.
const remoteOptions: ActionCli.Options<typeof RemoteAction> & ActionHttp.ClientOptions = {
  baseUrl: "http://localhost",
  render: (output) => output,
};

const remoteMake: ActionCli.MakeOptions & ActionHttp.ClientOptions = { name: "r" };

ActionCli.command(http, RemoteAction, remoteOptions);

ActionCli.make(http, remoteMake);

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

const shapes = Action.implement([ScalarInput, UnionInput, Other], {
  scalarInput: () => Effect.void,
  unionInput: () => Effect.void,
  other: () => Effect.succeed("other"),
});

// Only named fields of one struct may be positional: none for a scalar, a union or no input.
const noFields: [
  Equal<ActionCli.Options<typeof ScalarInput>["positional"], ReadonlyArray<never> | undefined>,
  Equal<ActionCli.Options<typeof UnionInput>["positional"], ReadonlyArray<never> | undefined>,
  Equal<ActionCli.Options<typeof Other>["positional"], ReadonlyArray<never> | undefined>,
] = [true, true, true];

void noFields;

// @ts-expect-error A union input has no positional fields, even shared ones.
ActionCli.command(shapes, UnionInput, { positional: ["a"] });
