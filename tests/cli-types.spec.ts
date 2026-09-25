// Compile-only public CLI API assertions.
import { Context, Effect, Option, Schema, Scope } from "effect";
import { HttpClient, type HttpClientError } from "effect/unstable/http";
import { Argument, Command, Flag } from "effect/unstable/cli";
import * as Action from "../src/Action.js";
import * as ActionCli from "../src/ActionCli.js";
import * as ActionCliClient from "../src/ActionCliClient.js";
import * as ActionHttp from "../src/ActionHttp.js";

type CommandError<C> =
  C extends Command.Command<infer _Name, infer _Input, infer _ContextInput, infer E, infer _R>
    ? E
    : never;

type CommandServices<C> =
  C extends Command.Command<infer _Name, infer _Input, infer _ContextInput, infer _E, infer R>
    ? R
    : never;

type Includes<Whole, Part> = Part extends Whole ? true : false;

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends <Value>() => Value extends Right ? 1 : 2
    ? true
    : false;

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

const guarded = ActionCli.command(local, One, {
  before: () => Effect.fail(new Refused()),
});

const guardedRefusal: Includes<CommandError<typeof guarded>, Refused> = true;

const guardedGroup = ActionCli.make(local, {
  name: "local",
  before: () => Effect.fail(new Refused()),
});

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

const HttpOnly = Action.make("httpOnly", {
  description: "HTTP only",
  access: "write",
  success: Schema.Finite,
  mcp: false,
});

const Other = Action.make("other", {
  description: "Other",
  access: "write",
  success: Schema.String,
});

const http = ActionHttp.make([RemoteAction, HttpOnly, Other], {
  schemaError: {
    invalid: { schema: Policy, make: () => new Policy() },
    internal: { schema: Policy, make: () => new Policy() },
  },
});

const remote = ActionCliClient.command(http, RemoteAction, {
  render: (output) => output.toUpperCase(),
});

const configuredRemote = ActionCliClient.command(http, RemoteAction, {
  parameters: { value: Argument.String("value") },
  input: ({ value }) => ({ value }),
  render: (output) => output.toUpperCase(),
});

const optionRemote = ActionCliClient.command(http, RemoteAction, {
  parameters: { value: Flag.String("value").pipe(Flag.optional) },
  input: ({ value }) => ({ value: Option.getOrElse(value, () => "") }),
});

const remoteHttpOnly = ActionCliClient.command(http, HttpOnly, {
  render: (output) => String(output.toFixed()),
});

const remoteGroup = ActionCliClient.make(http, { name: "remote" });

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

void remoteHttpOnly;

void remoteGroup;

// @ts-expect-error A remote command selects an action of the binding.
ActionCliClient.command(http, Plain);

// @ts-expect-error Explicit native parameters require their input mapper.
ActionCliClient.command(http, RemoteAction, {
  parameters: { value: Argument.String("value") },
});

// @ts-expect-error An input mapper without native parameters is not a command configuration.
ActionCliClient.command(http, RemoteAction, {
  input: () => ({ value: "ok" }),
});

ActionCliClient.command(http, RemoteAction, {
  parameters: { value: Argument.String("value") },
  // @ts-expect-error Mapper must return JSON; action schema shape is checked at runtime.
  input: () => undefined,
});
