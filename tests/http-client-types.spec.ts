// Compile-only client assertions, included by `vp check`.
import { type DateTime, Effect, Schema } from "effect";
import type { HttpClient, HttpClientError } from "effect/unstable/http";
import * as Action from "../src/Action.js";
import * as ActionHttp from "../src/ActionHttp.js";
import * as ActionHttpClient from "../src/ActionHttpClient.js";

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends <Value>() => Value extends Right ? 1 : 2
    ? true
    : false;

class Missing extends Schema.TaggedError<Missing>()("Missing", { id: Schema.String }) {}

class Denied extends Schema.TaggedError<Denied>()("Denied", {}, { httpApiStatus: 403 }) {}

class Invalid extends Schema.TaggedError<Invalid>()("Invalid", {}, { httpApiStatus: 400 }) {}

const Get = Action.make("get", {
  description: "Read a note",
  access: "read",
  input: { id: Schema.String },
  success: { id: Schema.String, at: Schema.DateTimeUtcFromString },
  errors: [Missing],
});

const List = Action.make("list", {
  description: "List notes",
  access: "read",
  input: { limit: Schema.optionalKey(Schema.Finite) },
  success: Schema.Array(Schema.String),
});

const Count = Action.make("count", {
  description: "Count notes",
  access: "read",
  success: Schema.Finite,
});

const Notes = [Get, List, Count] as const;

const client = ActionHttpClient.promise(ActionHttp.make(Notes));

export const decodedSuccess: Promise<{ readonly id: string; readonly at: DateTime.Utc }> =
  client.get({ id: "a" });

// The argument may be omitted exactly when `{}` is a valid input.
export const optionalInput: Promise<ReadonlyArray<string>> = client.list();

export const givenOptionalInput: Promise<ReadonlyArray<string>> = client.list({ limit: 1 });

export const noInput: Promise<number> = client.count();

export const promiseClientTypes = () => {
  // @ts-expect-error Input is typed by the action.
  void client.get({ id: 1 });
  // @ts-expect-error An action with required input needs its argument.
  void client.get();
  // @ts-expect-error An omitted argument is left out, not passed as `undefined`.
  void client.list(undefined);
  // @ts-expect-error An action declared without `input` takes no `undefined` either.
  void client.count(undefined);
  // @ts-expect-error `null` is not this action's input.
  void client.get(null);

  ActionHttpClient.promise(ActionHttp.make(Notes), {
    // @ts-expect-error A response transform could change what a method resolves with.
    transformResponse: (effect: Effect.Effect<unknown, unknown, unknown>) => effect,
  });

  // @ts-expect-error The success is the decoded type, not its JSON encoding.
  const encoded: Promise<{ readonly id: string; readonly at: string }> = client.get({
    id: "a",
  });

  return encoded;
};

// The Effect client: one method per action, input directly, the native `HttpClient` required.
const guarded = ActionHttp.make(Notes, {
  errors: [Denied],
  schemaError: {
    invalid: { schema: Invalid, make: () => new Invalid() },
    internal: { schema: Invalid, make: () => new Invalid() },
  },
});

const made = ActionHttpClient.make(guarded, { baseUrl: "http://localhost" });

export const effectClientRequires: Equal<
  Effect.Services<typeof made>,
  HttpClient.HttpClient
> = true;

export const effectClientTypes = Effect.gen(function* () {
  const methods = yield* made;
  const get = methods.get({ id: "a" });

  // Failures: the action's own, the binding's surface and policy errors, then transport
  // and encoding failures.
  const failures: Equal<
    Effect.Error<typeof get>,
    Missing | Denied | Invalid | HttpClientError.HttpClientError | Schema.SchemaError
  > = true;

  void failures;

  const count = methods.count();

  // An action without declared errors fails only with the binding's and the transport's.
  const countFailures: Equal<
    Effect.Error<typeof count>,
    Denied | Invalid | HttpClientError.HttpClientError | Schema.SchemaError
  > = true;

  void countFailures;

  const at: DateTime.Utc = (yield* get).at;
  void at;

  // @ts-expect-error Input is typed by the action.
  methods.get({ id: 1 });
  // @ts-expect-error Methods take the input itself, not a native payload wrapper.
  methods.get({ payload: { id: "a" } });

  const bare = yield* ActionHttpClient.make(ActionHttp.make(Notes));
  const bareCount = bare.count();

  // Without surface or policy errors, a method has none of them.
  const bareFailures: Equal<
    Effect.Error<typeof bareCount>,
    HttpClientError.HttpClientError | Schema.SchemaError
  > = true;

  void bareFailures;
});

ActionHttpClient.make(ActionHttp.make(Notes), {
  // @ts-expect-error A response transform could change what a method returns.
  transformResponse: (effect: Effect.Effect<unknown, unknown, unknown>) => effect,
});
