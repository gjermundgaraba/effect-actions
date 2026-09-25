// Compile-only public CLI API assertions.
import { Context, Effect, Option, Schema, Scope } from "effect";
import { HttpClient, type HttpClientError } from "effect/unstable/http";
import { Argument, Command, Flag } from "effect/unstable/cli";
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

class Refused extends Schema.TaggedError<Refused>()("Refused", {}) {}

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
// action's, the surface hook's and the CLI's own encoding error, never `unknown`.
const localOneErrorIsKnown: Equal<
  unknown extends CommandError<typeof localOne> ? true : false,
  false
> = true;

// The hook's failure is inferred: a CLI does not encode it, so nothing declares it.
const guarded = ActionCli.command(local, One, { before: () => Effect.fail(new Refused()) });

const guardedRefusal: Includes<CommandError<typeof guarded>, Refused> = true;

// A guard shared with the tool surfaces carries `errors`; the CLI reads only `before`.
const shared = { errors: [Refused], before: () => Effect.fail(new Refused()) };

const guardedGroup = ActionCli.make(local, { name: "local", ...shared });

const guardedGroupRefusal: Includes<CommandError<typeof guardedGroup>, Refused> = true;

void localOneBuild;

void localOneRequest;

void localOneNotTwo;

void localTwoRequest;

void localGroupBuild;

void localGroupOne;

void localGroupTwo;

void localGroupErrorIsKnown;

void localOneErrorIsKnown;

void guardedRefusal;

void guardedGroupRefusal;

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

// Native parameters without a mapper are the input as parsed.
ActionCli.command(local, One, { parameters: { value: Argument.String("value") } });

// @ts-expect-error Parsed parameters that are not the encoded input need a mapper.
ActionCli.command(local, One, { parameters: { other: Argument.String("other") } });

// @ts-expect-error An optional flag parses to an `Option`, which is not encoded input.
ActionCli.command(local, One, { parameters: { value: Flag.String("value").pipe(Flag.optional) } });

// With a mapper, any parameters do.
ActionCli.command(local, One, {
  parameters: { other: Argument.String("other") },
  input: ({ other }) => ({ value: other }),
});

// @ts-expect-error The renderer receives the selected action's exact success value.
ActionCli.command(local, Two, { render: (output: string) => output });

class Domain extends Schema.TaggedError<Domain>()("Domain", {}) {}

class Policy extends Schema.TaggedError<Policy>()("Policy", {}) {}

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

const http = ActionHttp.make([RemoteAction, Count, Other], {
  errors: [Policy],
  schemaError: { invalid: () => new Policy(), internal: () => new Policy() },
});

const remote = ActionCli.command(http, RemoteAction, {
  render: (output) => output.toUpperCase(),
});

const configuredRemote = ActionCli.command(http, RemoteAction, {
  parameters: { value: Argument.String("value") },
  input: ({ value }) => ({ value }),
  render: (output) => output.toUpperCase(),
});

const optionRemote = ActionCli.command(http, RemoteAction, {
  parameters: { value: Flag.String("value").pipe(Flag.optional) },
  input: ({ value }) => ({ value: Option.getOrElse(value, () => "") }),
});

const remoteCount = ActionCli.command(http, Count, {
  render: (output) => String(output.toFixed()),
});

const remoteGroup = ActionCli.make(http, { name: "remote" });

const remoteHttpClient: Includes<CommandServices<typeof remote>, HttpClient.HttpClient> = true;

const remoteDomain: Includes<CommandError<typeof remote>, Domain> = true;

const remotePolicy: Includes<CommandError<typeof remote>, Policy> = true;

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

void remotePolicy;

void remoteClientError;

void remoteSchema;

void remoteGroupErrorIsKnown;

void configuredRemote;

void optionRemote;

void remoteCount;

void remoteGroup;

// @ts-expect-error A remote command selects an action of the binding.
ActionCli.command(http, Plain);

// Explicit native parameters without a mapper send the parsed parameters as the input.
ActionCli.command(http, RemoteAction, {
  parameters: { value: Argument.String("value") },
});

// @ts-expect-error An input mapper without native parameters is not a command configuration.
ActionCli.command(http, RemoteAction, {
  input: () => ({ value: "ok" }),
});

// @ts-expect-error Mapper must return JSON; action schema shape is checked at runtime.
ActionCli.command(http, RemoteAction, {
  parameters: { value: Argument.String("value") },
  input: () => undefined,
});

// A command from a binding fails with exactly what its client method fails with: the
// action's own errors, the binding's surface errors, and the native transport and schema
// failures.
class Denied extends Schema.TaggedError<Denied>()("Denied", {}, { httpApiStatus: 403 }) {}

class Gone extends Schema.TaggedError<Gone>()("Gone", {}, { httpApiStatus: 410 }) {}

const Erring = Action.make("erring", {
  description: "Declares an error",
  access: "read",
  success: Schema.String,
  errors: [Gone],
});

const Guarded = ActionHttp.make([Plain, Erring], { errors: [Denied] });

type Transport = HttpClientError.HttpClientError | Schema.SchemaError;

const guardedPlain = ActionCli.command(Guarded, Plain);

const guardedErring = ActionCli.command(Guarded, Erring);

const guardedAll = ActionCli.make(Guarded, { name: "remote" });

const remoteErrors: [
  Equal<Command.Error<typeof guardedPlain>, Denied | Transport>,
  Equal<Command.Error<typeof guardedErring>, Gone | Denied | Transport>,
  Equal<Command.Error<typeof guardedAll>, Gone | Denied | Transport>,
] = [true, true, true];

void remoteErrors;

// The server owns authorization: a command from a binding binds no hook.
const remoteOptionsHaveNoHook: [
  "before" extends keyof ActionCli.RemoteOptions<string> ? true : false,
  "before" extends keyof ActionCli.RemoteMakeOptions ? true : false,
] = [false, false];

void remoteOptionsHaveNoHook;

// @ts-expect-error A remote command binds no hook.
ActionCli.command(Guarded, Plain, { before: () => Effect.void });

const transformResponse = <A, E, R>(effect: Effect.Effect<A, E, R>) => effect;

// `transformResponse` could change a call's failures, which the command's type states.
// @ts-expect-error The command takes the client's options, which exclude it.
ActionCli.command(Guarded, Plain, { transformResponse });

// @ts-expect-error The aggregate excludes it too.
ActionCli.make(Guarded, { name: "r", transformResponse });

// @ts-expect-error An aggregate remote command needs a name.
ActionCli.make(Guarded, {});
