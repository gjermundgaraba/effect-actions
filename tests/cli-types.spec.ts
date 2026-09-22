// Compile-only public CLI API assertions.
import { Context, Effect, Option, Schema, Scope } from "effect";
import { HttpClient, type HttpClientError } from "effect/unstable/http";
import { Argument, Command, Flag } from "effect/unstable/cli";
import * as Action from "../src/Action.js";
import * as ActionCli from "../src/ActionCli.js";
import * as ActionCliClient from "../src/ActionCliClient.js";
import * as ActionGroup from "../src/ActionGroup.js";
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

const LocalGroup = ActionGroup.make({ name: "local" }, One, Two);

const local = LocalGroup.implement(
  Effect.map(Build, (prefix) => ({
    one: ({ value }: { value: string }) =>
      Effect.map(OneRequest, (request) => `${prefix}${request}${value}`),
    two: ({ value }: { value: number }) => Effect.map(TwoRequest, (request) => value + request),
  })),
);

const localOne = ActionCli.command(local, "one", {
  render: (output) => output.toUpperCase(),
});

const localTwo = ActionCli.command(local, "two", {
  render: (output) => String(output.toFixed()),
});

const localGroup = ActionCli.group(local);

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

const guarded = ActionCli.command(local, "one", {
  before: () => Effect.fail(new Refused()),
});

const guardedRefusal: Includes<CommandError<typeof guarded>, Refused> = true;

const guardedGroup = ActionCli.group(local, { before: () => Effect.fail(new Refused()) });

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

const noService = ActionGroup.make(
  { name: "plain" },
  Action.make("plain", { description: "Plain", access: "write", success: Schema.String }),
).implement({ plain: () => Effect.succeed("plain") });

const plainCommand = ActionCli.command(noService, "plain");

const plainGroup = ActionCli.group(noService);

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

const scoped = ActionGroup.make(
  { name: "scoped" },
  Action.make("scoped", { description: "Scoped", access: "write", success: Schema.String }),
).implement(
  Effect.acquireRelease(
    Effect.succeed({ scoped: () => Effect.succeed("scoped") }),
    () => Effect.void,
  ),
);

const scopedCommand = ActionCli.command(scoped, "scoped");

const scopedGroup = ActionCli.group(scoped);

const scopedCommandHasNoScope: Includes<CommandServices<typeof scopedCommand>, Scope.Scope> = false;

const scopedGroupHasNoScope: Includes<CommandServices<typeof scopedGroup>, Scope.Scope> = false;

void scopedCommandHasNoScope;

void scopedGroupHasNoScope;

const scopedHandler = ActionGroup.make(
  { name: "scoped-handler" },
  Action.make("scopedHandler", {
    description: "Scoped handler",
    access: "write",
    success: Schema.String,
  }),
).implement({
  scopedHandler: () => Effect.acquireRelease(Effect.succeed("scoped handler"), () => Effect.void),
});

const scopedHandlerCommand = ActionCli.command(scopedHandler, "scopedHandler");

const scopedHandlerGroup = ActionCli.group(scopedHandler);

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

// @ts-expect-error Local command names must belong to the implementation's group.
ActionCli.command(local, "missing");

// @ts-expect-error The renderer receives the selected action's exact success value.
ActionCli.command(local, "two", { render: (output: string) => output });

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

const Hidden = Action.make("hidden", {
  description: "Hidden",
  access: "write",
  success: Schema.String,
  http: false,
});

const RemoteGroup = ActionGroup.make(
  {
    name: "remote",
    schemaError: {
      invalid: { schema: Policy, make: () => new Policy() },
      internal: { schema: Policy, make: () => new Policy() },
    },
  },
  RemoteAction,
  HttpOnly,
  Hidden,
);

const OtherGroup = ActionGroup.make(
  { name: "other" },
  Action.make("other", { description: "Other", access: "write", success: Schema.String }),
);

const http = ActionHttp.make({ apiPath: "/api" }, RemoteGroup, OtherGroup);

const StringShared = ActionGroup.make(
  { name: "string-shared" },
  Action.make("shared", { description: "String shared", access: "write", success: Schema.String }),
);

const NumberShared = ActionGroup.make(
  { name: "number-shared" },
  Action.make("shared", { description: "Number shared", access: "write", success: Schema.Finite }),
);

const sharedHttp = ActionHttp.make({ apiPath: "/shared" }, StringShared, NumberShared);

const sharedString = ActionCliClient.command(sharedHttp, "string-shared", "shared", {
  render: (output) => output.toUpperCase(),
});

const sharedNumber = ActionCliClient.command(sharedHttp, "number-shared", "shared", {
  render: (output) => output.toFixed(),
});

const remote = ActionCliClient.command(http, "remote", "remote", {
  render: (output) => output.toUpperCase(),
});

const configuredRemote = ActionCliClient.command(http, "remote", "remote", {
  parameters: { value: Argument.String("value") },
  input: ({ value }) => ({ value }),
  render: (output) => output.toUpperCase(),
});

const optionRemote = ActionCliClient.command(http, "remote", "remote", {
  parameters: { value: Flag.String("value").pipe(Flag.optional) },
  input: ({ value }) => ({ value: Option.getOrElse(value, () => "") }),
});

const remoteHttpOnly = ActionCliClient.command(http, "remote", "httpOnly", {
  render: (output) => String(output.toFixed()),
});

const remoteGroup = ActionCliClient.group(http, "remote");

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

void sharedString;

void sharedNumber;

// @ts-expect-error HTTP-disabled actions have no remote command.
ActionCliClient.command(http, "remote", "hidden");

// @ts-expect-error Remote command names are exact.
ActionCliClient.command(http, "remote", "missing");

// @ts-expect-error An action of another mounted group cannot leak through this group's command.
ActionCliClient.command(http, "remote", "other");

// @ts-expect-error Selectors are strings retained by the HTTP binding, not separately supplied groups.
ActionCliClient.command(http, RemoteGroup, "remote");

// @ts-expect-error Explicit native parameters require their input mapper.
ActionCliClient.command(http, "remote", "remote", {
  parameters: { value: Argument.String("value") },
});

// @ts-expect-error An input mapper without native parameters is not a command configuration.
ActionCliClient.command(http, "remote", "remote", {
  input: () => ({ value: "ok" }),
});

ActionCliClient.command(http, "remote", "remote", {
  parameters: { value: Argument.String("value") },
  // @ts-expect-error Mapper must return JSON; action schema shape is checked at runtime.
  input: () => undefined,
});
