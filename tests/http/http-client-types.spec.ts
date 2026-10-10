import { type DateTime, Effect, Schema } from "effect";
import type { HttpClient, HttpClientError } from "effect/http";
import { expectTypeOf } from "@effect/vitest";
import * as Action from "../../src/contract/Action.js";
import * as ActionHttp from "../../src/http/ActionHttp.js";
import * as Testing from "../../src/testing/Testing.js";

class Missing extends Schema.TaggedError<Missing>()("Missing", { id: Schema.String }) {}

const Get = Action.make("get", {
  description: "Read a note",
  readOnly: true,
  caller: Action.Anyone,
  input: { id: Schema.String },
  success: { id: Schema.String, at: Schema.DateTimeUtcFromString },
  error: [Missing],
});

const List = Action.make("list", {
  description: "List notes",
  readOnly: true,
  caller: Action.Anyone,
  input: { limit: Schema.optionalKey(Schema.Finite) },
  success: Schema.Array(Schema.String),
});

const Count = Action.make("count", {
  description: "Count notes",
  readOnly: true,
  caller: Action.Anyone,
  success: Schema.Finite,
});

const Notes = [Get, List, Count] as const;

type EveryCallFailure =
  | Action.InvalidInput
  | Action.Unauthenticated
  | Action.Forbidden
  | HttpClientError.HttpClientError
  | Schema.SchemaError;

const effectClient = ActionHttp.client(ActionHttp.make(Notes), { baseUrl: "http://localhost" });

expectTypeOf<Effect.Services<typeof effectClient>>().toEqualTypeOf<HttpClient.HttpClient>();

export const effectClientTypes = Effect.gen(function* () {
  const methods = yield* effectClient;
  const get = methods.get({ id: "a" });

  expectTypeOf<Effect.Error<typeof get>>().toEqualTypeOf<Missing | EveryCallFailure>();

  const count = methods.count();

  expectTypeOf<Effect.Error<typeof count>>().toEqualTypeOf<EveryCallFailure>();

  yield* count.pipe(
    Effect.catchTag("InvalidInput", ({ message }) => Effect.succeed(message.length)),
    Effect.catchTag("Unauthenticated", () => Effect.succeed(0)),
    Effect.catchTag("Forbidden", () => Effect.succeed(0)),
  );

  // @ts-expect-error -- Undeclared, so the client has no such failure to catch.
  yield* count.pipe(Effect.catchTag("Missing", () => Effect.succeed(0)));

  expectTypeOf<Effect.Success<typeof get>>().toEqualTypeOf<{
    readonly id: string;
    readonly at: DateTime.Utc;
  }>();

  const at: DateTime.Utc = (yield* get).at;
  void at;

  const listed: ReadonlyArray<string> = yield* methods.list();
  const limited: ReadonlyArray<string> = yield* methods.list({ limit: 1 });
  const counted: number = yield* methods.count();
  void listed;
  void limited;
  void counted;

  // @ts-expect-error -- Input is typed by the action.
  methods.get({ id: 1 });
  // @ts-expect-error -- An action with required input needs its argument.
  methods.get();
  // @ts-expect-error -- An omitted argument is left out, not passed as `undefined`.
  methods.list(undefined);
  // @ts-expect-error -- An action declared without `input` takes no `undefined` either.
  methods.count(undefined);
  // @ts-expect-error -- `null` is not this action's input.
  methods.get(null);
  // @ts-expect-error -- Methods take the input itself, not a native payload wrapper.
  methods.get({ payload: { id: "a" } });
});

class Filters extends Schema.Class<Filters>("Filters")({
  tag: Schema.optionalKey(Schema.String),
}) {}

class Lookup extends Schema.Class<Lookup>("Lookup")({ id: Schema.String }) {}

const Filter = Action.make("filter", {
  description: "Filter notes",
  readOnly: true,
  caller: Action.Anyone,
  input: Filters,
  success: Schema.Array(Schema.String),
});

const Find = Action.make("find", {
  description: "Find a note",
  readOnly: true,
  caller: Action.Anyone,
  input: Lookup,
  success: Schema.String,
});

export const classInputOmittedWhenItsFieldsAreOptional = Effect.gen(function* () {
  const methods = yield* ActionHttp.client(ActionHttp.make([Filter, Find]));
  const mcp = yield* Testing.mcpClient([Filter, Find]);

  const all: ReadonlyArray<string> = yield* methods.filter();
  const tagged: ReadonlyArray<string> = yield* methods.filter(new Filters({ tag: "x" }));
  const tool: ReadonlyArray<string> = yield* mcp.filter();

  void all;
  void tagged;
  void tool;

  // @ts-expect-error -- A class with a required field needs its argument, as a struct does.
  methods.find();
  // @ts-expect-error -- Its tool call needs the argument too.
  void mcp.find();
});

ActionHttp.client(ActionHttp.make(Notes), {
  // @ts-expect-error -- A response transform could change what a method returns.
  transformResponse: (effect: Effect.Effect<unknown, unknown, unknown>) => effect,
});

const fetched = ActionHttp.fetchClient(ActionHttp.make(Notes), {
  baseUrl: "http://localhost",
  fetch: (input, init) => globalThis.fetch(input, init),
});

expectTypeOf(fetched).toEqualTypeOf<ActionHttp.Client<ActionHttp.Binding<typeof Notes>>>();

expectTypeOf<Effect.Services<ReturnType<typeof fetched.get>>>().toEqualTypeOf<never>();

const wrapperPassingOptionalFetch = (fetch?: typeof globalThis.fetch) =>
  ActionHttp.fetchClient(ActionHttp.make(Notes), { fetch });

expectTypeOf(wrapperPassingOptionalFetch).returns.toEqualTypeOf<typeof fetched>();

ActionHttp.fetchClient(ActionHttp.make(Notes), {
  // @ts-expect-error -- The fetch client takes no response transform either.
  transformResponse: (effect: Effect.Effect<unknown, unknown, unknown>) => effect,
});

class Throttled extends Schema.TaggedError<Throttled>()("Throttled", {}, { httpApiStatus: 429 }) {}

const Throttling = ActionHttp.make(Notes, { error: [Throttled] });

export const bindingErrorTypes = Effect.gen(function* () {
  const methods = yield* ActionHttp.client(Throttling);

  expectTypeOf<Effect.Error<ReturnType<typeof methods.get>>>().toEqualTypeOf<
    Missing | Throttled | EveryCallFailure
  >();

  expectTypeOf<Effect.Error<ReturnType<typeof methods.count>>>().toEqualTypeOf<
    Throttled | EveryCallFailure
  >();

  yield* methods.count().pipe(Effect.catchTag("Throttled", () => Effect.succeed(0)));
});
