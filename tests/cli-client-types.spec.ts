// Remote commands cannot install a local authorization hook, and select only bound actions.
import { type Effect, Schema } from "effect";
import type { Command } from "effect/unstable/cli";
import type { HttpClientError } from "effect/unstable/http";
import * as Action from "../src/Action.js";
import * as ActionHttp from "../src/ActionHttp.js";
import * as ActionCliClient from "../src/ActionCliClient.js";

export const remoteOptionsHaveNoHook: "before" extends keyof ActionCliClient.Options<string>
  ? true
  : false = false;

export const remoteMakeOptionsHaveNoHook: "before" extends keyof ActionCliClient.MakeOptions
  ? true
  : false = false;

const Bound = Action.make("bound", {
  description: "Bound",
  access: "read",
  success: Schema.String,
});

const Outside = Action.make("outside", {
  description: "Not in the binding",
  access: "read",
  success: Schema.String,
});

const Http = ActionHttp.make([Bound]);

export const bound = ActionCliClient.command(Http, Bound);

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends <Value>() => Value extends Right ? 1 : 2
    ? true
    : false;

class Refused extends Schema.TaggedError<Refused>()("Refused", {}, { httpApiStatus: 403 }) {}

class Gone extends Schema.TaggedError<Gone>()("Gone", {}, { httpApiStatus: 410 }) {}

const Erring = Action.make("erring", {
  description: "Declares an error",
  access: "read",
  success: Schema.String,
  errors: [Gone],
});

const Guarded = ActionHttp.make([Bound, Erring], { errors: [Refused] });

type Transport = HttpClientError.HttpClientError | Schema.SchemaError;

// A command fails with exactly what its client method fails with: the action's own errors,
// the binding's surface errors, and the native transport and schema failures.
export const commandErrors: [
  Equal<
    Command.Error<ReturnType<typeof ActionCliClient.command<typeof Guarded, typeof Bound>>>,
    Refused | Transport
  >,
  Equal<
    Command.Error<ReturnType<typeof ActionCliClient.command<typeof Guarded, typeof Erring>>>,
    Gone | Refused | Transport
  >,
  Equal<
    Command.Error<ReturnType<typeof ActionCliClient.make<typeof Guarded>>>,
    Gone | Refused | Transport
  >,
] = [true, true, true];

// @ts-expect-error A remote command exists only for an action the binding lists.
export const outside = ActionCliClient.command(Http, Outside);

export const aggregate = ActionCliClient.make(Http, { name: "remote" });

const transformResponse = <A, E, R>(effect: Effect.Effect<A, E, R>) => effect;

// `transformResponse` could change a call's failures, which the command's type states.
// @ts-expect-error The connection is the client's options, which exclude it.
export const reshaped = ActionCliClient.command(Http, Bound, { connection: { transformResponse } });

export const reshapedAll = ActionCliClient.make(Http, {
  name: "r",
  // @ts-expect-error The aggregate's connection excludes it too.
  connection: { transformResponse },
});

// @ts-expect-error An aggregate remote command needs a name.
export const unnamed = ActionCliClient.make(Http, {});
