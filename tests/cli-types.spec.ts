// Compile-only public CLI API assertions.
import { Context, Effect, Schema, Scope } from "effect";
import { HttpClient, type HttpClientError } from "effect/unstable/http";
import type { Command } from "effect/unstable/cli";
import * as Action from "../src/Action.js";
import * as ActionCli from "../src/ActionCli.js";
import * as ActionHttp from "../src/ActionHttp.js";
import type { Equal } from "./equal.js";

type CommandError<C> =
  C extends Command.Command<infer _Name, infer _Input, infer _ContextInput, infer E, infer _R>
    ? E
    : never;

type CommandServices<C> =
  C extends Command.Command<infer _Name, infer _Input, infer _ContextInput, infer _E, infer R>
    ? R
    : never;

type Includes<Whole, Part> = Part extends Whole ? true : false;

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

const localOneBuild: Includes<CommandServices<typeof localOne>, Build> = true;

const localOneRequest: Includes<CommandServices<typeof localOne>, OneRequest> = true;

const localOneNotTwo: Includes<CommandServices<typeof localOne>, TwoRequest> = false;

const localTwoRequest: Includes<CommandServices<typeof localTwo>, TwoRequest> = true;

const localGroupBuild: Includes<CommandServices<typeof localGroup>, Build> = true;

const localGroupOne: Includes<CommandServices<typeof localGroup>, OneRequest> = true;

const localGroupTwo: Includes<CommandServices<typeof localGroup>, TwoRequest> = true;

const localGroupErrorIsKnown: Equal<
  unknown extends CommandError<typeof localGroup> ? true : false,
  false
> = true;

// A selected command is typed like the aggregate one: its failures are the
// action's, the implementation hook's and the CLI's own encoding error, never `unknown`.
const localOneErrorIsKnown: Equal<
  unknown extends CommandError<typeof localOne> ? true : false,
  false
> = true;

// Any implementation may refuse: every local command fails with `Refusal`, beside the
// action's own failures and invalid input, whatever its hook.
const forbid = () => Effect.fail(new Action.Forbidden());

const forbidding = Action.implement(One, ({ value }) => Effect.succeed(value), { before: forbid });

const refuse = Effect.fn(function* (action: Action.Any) {
  yield* Hooked;

  if (action.access === "write") return yield* new Action.Unauthenticated();

  return yield* new Action.Forbidden();
});

const refusing = ActionCli.command(
  Action.implement(One, ({ value }) => Effect.succeed(value), { before: refuse }),
  One,
  { render: (output) => output.toUpperCase() },
);

const refusalErrors: [
  Equal<CommandError<typeof localOne>, Action.Refusal | Schema.SchemaError>,
  Equal<CommandError<typeof refusing>, Action.Refusal | Schema.SchemaError>,
] = [true, true];

// The hook's services are the command's too.
const refusingHooked: Includes<CommandServices<typeof refusing>, Hooked> = true;

// @ts-expect-error A contract it does not implement is refused.
ActionCli.command(forbidding, Two);

void localOneBuild;

void localOneRequest;

void localOneNotTwo;

void localTwoRequest;

void localGroupBuild;

void localGroupOne;

void localGroupTwo;

void localGroupErrorIsKnown;

void localOneErrorIsKnown;

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

const noUnknown: Equal<
  unknown extends CommandServices<typeof plainCommand> ? true : false,
  false
> = true;

void noUnknown;

const plainGroupNoUnknown: Equal<
  unknown extends CommandServices<typeof plainGroup> ? true : false,
  false
> = true;

void plainGroupNoUnknown;

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

const scopedCommandHasNoScope: Includes<CommandServices<typeof scopedCommand>, Scope.Scope> = false;

const scopedGroupHasNoScope: Includes<CommandServices<typeof scopedGroup>, Scope.Scope> = false;

void scopedCommandHasNoScope;

void scopedGroupHasNoScope;

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

const scopedHandlerCommandHasNoScope: Includes<
  CommandServices<typeof scopedHandlerCommand>,
  Scope.Scope
> = false;

const scopedHandlerGroupHasNoScope: Includes<
  CommandServices<typeof scopedHandlerGroup>,
  Scope.Scope
> = false;

void scopedHandlerCommandHasNoScope;

void scopedHandlerGroupHasNoScope;

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

const remoteHttpClient: Includes<CommandServices<typeof remote>, HttpClient.HttpClient> = true;

const remoteDomain: Includes<CommandError<typeof remote>, Domain> = true;

// Every endpoint declares bad input and both refusals, and the client decodes them.
const remoteBuiltIns: [
  Includes<CommandError<typeof remote>, Action.InvalidInput>,
  Includes<CommandError<typeof remote>, Action.Unauthenticated>,
  Includes<CommandError<typeof remote>, Action.Forbidden>,
] = [true, true, true];

const remoteClientError: Includes<
  CommandError<typeof remote>,
  HttpClientError.HttpClientError
> = true;

const remoteSchema: Includes<CommandError<typeof remote>, Schema.SchemaError> = true;

const remoteGroupErrorIsKnown: Equal<
  unknown extends CommandError<typeof remoteGroup> ? true : false,
  false
> = true;

void remoteHttpClient;

void remoteDomain;

void remoteBuiltIns;

void remoteClientError;

void remoteSchema;

void remoteGroupErrorIsKnown;

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
