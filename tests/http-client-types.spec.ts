// Compile-only client assertions, included by `vp check`.
import { type DateTime, Effect, Schema } from "effect";
import type { HttpClient, HttpClientError } from "effect/http";
import * as Action from "../src/Action.js";
import * as ActionHttp from "../src/ActionHttp.js";
import * as Testing from "../src/Testing.js";
import type { Equal } from "./equal.js";

class Missing extends Schema.TaggedError<Missing>()("Missing", { id: Schema.String }) {}

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

/** What every call may fail with besides the action's own errors. */
type BuiltIn =
  | Action.InvalidInput
  | Action.Unauthenticated
  | Action.Forbidden
  | HttpClientError.HttpClientError
  | Schema.SchemaError;

// The Effect client: one method per action, input directly, the native `HttpClient` required.
const made = ActionHttp.client(ActionHttp.make(Notes), { baseUrl: "http://localhost" });

export const effectClientRequires: Equal<
  Effect.Services<typeof made>,
  HttpClient.HttpClient
> = true;

export const effectClientTypes = Effect.gen(function* () {
  const methods = yield* made;
  const get = methods.get({ id: "a" });

  // Failures: the action's own, the built-in refusals and bad input, then transport
  // and encoding failures.
  const failures: Equal<Effect.Error<typeof get>, Missing | BuiltIn> = true;

  void failures;

  const count = methods.count();

  // An action without declared errors fails only with the built-in ones and the transport's.
  const countFailures: Equal<Effect.Error<typeof count>, BuiltIn> = true;

  void countFailures;

  // Each built-in failure is typed, so a caller catches it by its tag.
  yield* count.pipe(
    Effect.catchTag("InvalidInput", ({ message }) => Effect.succeed(message.length)),
    Effect.catchTag("Unauthenticated", () => Effect.succeed(0)),
    Effect.catchTag("Forbidden", () => Effect.succeed(0)),
  );

  // @ts-expect-error Undeclared, so the client has no such failure to catch.
  yield* count.pipe(Effect.catchTag("Missing", () => Effect.succeed(0)));

  // The success is the decoded type, not its JSON encoding.
  const decoded: Equal<
    Effect.Success<typeof get>,
    { readonly id: string; readonly at: DateTime.Utc }
  > = true;

  void decoded;

  const at: DateTime.Utc = (yield* get).at;
  void at;

  // The argument may be omitted exactly when `{}` is a valid input.
  const listed: ReadonlyArray<string> = yield* methods.list();
  const limited: ReadonlyArray<string> = yield* methods.list({ limit: 1 });
  const counted: number = yield* methods.count();
  void listed;
  void limited;
  void counted;

  // @ts-expect-error Input is typed by the action.
  methods.get({ id: 1 });
  // @ts-expect-error An action with required input needs its argument.
  methods.get();
  // @ts-expect-error An omitted argument is left out, not passed as `undefined`.
  methods.list(undefined);
  // @ts-expect-error An action declared without `input` takes no `undefined` either.
  methods.count(undefined);
  // @ts-expect-error `null` is not this action's input.
  methods.get(null);
  // @ts-expect-error Methods take the input itself, not a native payload wrapper.
  methods.get({ payload: { id: "a" } });
});

// An input class follows the same rule, on a client and `Testing.mcpClient` alike: left out
// when its fields are all optional, sending the instance `{}` decodes to.
class Filters extends Schema.Class<Filters>("Filters")({
  tag: Schema.optionalKey(Schema.String),
}) {}

class Lookup extends Schema.Class<Lookup>("Lookup")({ id: Schema.String }) {}

const Filter = Action.make("filter", {
  description: "Filter notes",
  access: "read",
  input: Filters,
  success: Schema.Array(Schema.String),
});

const Find = Action.make("find", {
  description: "Find a note",
  access: "read",
  input: Lookup,
  success: Schema.String,
});

export const classInputTypes = Effect.gen(function* () {
  const methods = yield* ActionHttp.client(ActionHttp.make([Filter, Find]));
  const mcp = yield* Testing.mcpClient([Filter, Find]);

  const all: ReadonlyArray<string> = yield* methods.filter();
  const tagged: ReadonlyArray<string> = yield* methods.filter(new Filters({ tag: "x" }));
  const tool: ReadonlyArray<string> = yield* mcp.filter();

  void all;
  void tagged;
  void tool;

  // @ts-expect-error A class with a required field needs its argument, as a struct does.
  methods.find();
  // @ts-expect-error So does its tool call.
  void mcp.find();
});

ActionHttp.client(ActionHttp.make(Notes), {
  // @ts-expect-error A response transform could change what a method returns.
  transformResponse: (effect: Effect.Effect<unknown, unknown, unknown>) => effect,
});

// A binding's errors fail every method, beside each action's own; handlers are unaffected.
class Throttled extends Schema.TaggedError<Throttled>()("Throttled", {}, { httpApiStatus: 429 }) {}

const Throttling = ActionHttp.make(Notes, { errors: [Throttled] });

export const bindingErrorTypes = Effect.gen(function* () {
  const methods = yield* ActionHttp.client(Throttling);

  const getFailures: Equal<
    Effect.Error<ReturnType<typeof methods.get>>,
    Missing | Throttled | BuiltIn
  > = true;

  const countFailures: Equal<
    Effect.Error<ReturnType<typeof methods.count>>,
    Throttled | BuiltIn
  > = true;

  void getFailures;
  void countFailures;

  yield* methods.count().pipe(Effect.catchTag("Throttled", () => Effect.succeed(0)));
});

Action.implement(
  Get,
  {
    // @ts-expect-error A handler fails with its action's errors only, never a binding's.
    get: () => Effect.fail(new Throttled()),
  },
  Action.allowAll,
);
