import { expectTypeOf } from "@effect/vitest";
import { Effect, Schema } from "effect";
import type { DateTime } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import type { HttpClientError } from "effect/http";

import * as Action from "../../src/contract/Action.js";
import * as ActionHttp from "../../src/http/ActionHttp.js";
import * as ActionMcp from "../../src/mcp/ActionMcp.js";
import {
  authorize,
  authorizing,
  Credentials,
  SignInRequired,
} from "../support/credentials.js";

class Missing extends Schema.TaggedError<
  Missing,
  { readonly brand: unique symbol }
>()("Missing", {
  id: Schema.String,
}) {}

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

const effectClient = ActionHttp.client(ActionHttp.make(Notes), {
  baseUrl: "http://localhost",
});

expectTypeOf<
  Effect.Services<typeof effectClient>
>().toEqualTypeOf<HttpClient.HttpClient>();

export const effectClientTypes = Effect.gen(function* () {
  const methods = yield* effectClient;
  const get = methods.get({ id: "a" });

  expectTypeOf<Effect.Error<typeof get>>().toEqualTypeOf<
    Missing | EveryCallFailure
  >();

  const count = methods.count();

  expectTypeOf<Effect.Error<typeof count>>().toEqualTypeOf<EveryCallFailure>();

  yield* count.pipe(
    Effect.catchTags({
      InvalidInput: ({ message }) => Effect.succeed(message.length),
      Unauthenticated: () => Effect.succeed(0),
      Forbidden: () => Effect.succeed(0),
    })
  );

  // @ts-expect-error -- Undeclared, so the client has no such failure to catch.
  yield* count.pipe(Effect.catchTag("Missing", () => Effect.succeed(0)));

  expectTypeOf<Effect.Success<typeof get>>().toEqualTypeOf<{
    readonly id: string;
    readonly at: DateTime.Utc;
  }>();

  const at: DateTime.Utc = (yield* get).at;
  void at;

  const listed: readonly string[] = yield* methods.list();
  const limited: readonly string[] = yield* methods.list({ limit: 1 });
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

class Filters extends Schema.Class<Filters, { readonly brand: unique symbol }>(
  "Filters"
)({
  tag: Schema.optionalKey(Schema.String),
}) {}

class Lookup extends Schema.Class<Lookup, { readonly brand: unique symbol }>(
  "Lookup"
)({ id: Schema.String }) {}

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

export const classInputOmittedWhenItsFieldsAreOptional = Effect.gen(
  function* () {
    const methods = yield* ActionHttp.client(ActionHttp.make([Filter, Find]));
    const mcp = yield* ActionMcp.client([Filter, Find]);

    const all: readonly string[] = yield* methods.filter();

    const tagged: readonly string[] = yield* methods.filter(
      new Filters({ tag: "x" })
    );

    const tool: readonly string[] = yield* mcp.filter();

    void all;
    void tagged;
    void tool;

    // @ts-expect-error -- A class with a required field needs its argument, as a struct does.
    methods.find();
    // @ts-expect-error -- Its tool call needs the argument too.
    void mcp.find();
  }
);

ActionHttp.client(ActionHttp.make(Notes), {
  // @ts-expect-error -- A response transform could change what a method returns.
  transformResponse: <A, E, R>(effect: Effect.Effect<A, E, R>) => effect,
});

const fetched = ActionHttp.fetchClient(ActionHttp.make(Notes), {
  baseUrl: "http://localhost",
  fetch: async (input, init) => await globalThis.fetch(input, init),
});

expectTypeOf(fetched).toEqualTypeOf<
  ActionHttp.Client<ActionHttp.Binding<typeof Notes>>
>();

expectTypeOf<
  Effect.Services<ReturnType<typeof fetched.get>>
>().toEqualTypeOf<never>();

const wrapperPassingOptionalFetch = (fetch?: typeof globalThis.fetch) =>
  ActionHttp.fetchClient(ActionHttp.make(Notes), { fetch });

expectTypeOf(wrapperPassingOptionalFetch).returns.toEqualTypeOf<
  typeof fetched
>();

ActionHttp.fetchClient(ActionHttp.make(Notes), {
  // @ts-expect-error -- The fetch client takes no response transform either.
  transformResponse: <A, E, R>(effect: Effect.Effect<A, E, R>) => effect,
});

class Throttled extends Schema.TaggedError<
  Throttled,
  { readonly brand: unique symbol }
>()("Throttled", {}, { httpApiStatus: 429 }) {}

const Throttling = ActionHttp.make(Notes, { error: [Throttled] });

export const bindingErrorTypes = Effect.gen(function* () {
  const methods = yield* ActionHttp.client(Throttling);

  expectTypeOf<Effect.Error<ReturnType<typeof methods.get>>>().toEqualTypeOf<
    Missing | Throttled | EveryCallFailure
  >();

  expectTypeOf<Effect.Error<ReturnType<typeof methods.count>>>().toEqualTypeOf<
    Throttled | EveryCallFailure
  >();

  yield* methods
    .count()
    .pipe(Effect.catchTag("Throttled", () => Effect.succeed(0)));
});

export const transformErrorsAndServices = Effect.gen(function* () {
  const built = ActionHttp.client(Throttling, { transformClient: authorizing });

  expectTypeOf<
    Effect.Services<typeof built>
  >().toEqualTypeOf<HttpClient.HttpClient>();

  const methods = yield* built;
  const get = methods.get({ id: "a" });

  expectTypeOf<Effect.Error<typeof get>>().toEqualTypeOf<
    Missing | Throttled | SignInRequired | EveryCallFailure
  >();
  expectTypeOf<Effect.Services<typeof get>>().toEqualTypeOf<Credentials>();

  const inline = yield* ActionHttp.client(Throttling, {
    transformClient: (client) => HttpClient.mapRequestEffect(client, authorize),
  });

  expectTypeOf(inline).toEqualTypeOf(methods);

  yield* methods.count().pipe(
    Effect.catchTag("SignInRequired", () => Effect.succeed(0)),
    Effect.provideService(Credentials, { token: Effect.succeed("t0k") })
  );

  const count = methods.count();

  // @ts-expect-error -- A call requires what the transform requires.
  const unprovided: Effect.Effect<
    Effect.Success<typeof count>,
    Effect.Error<typeof count>
  > = count;

  void unprovided;
});

export const plainTransformKeepsTheChannels = Effect.gen(function* () {
  const bearer = {
    transformClient: HttpClient.mapRequest(
      HttpClientRequest.bearerToken("t0k")
    ),
  };

  const methods = yield* ActionHttp.client(Throttling, bearer);
  const count = methods.count();

  expectTypeOf<Effect.Error<typeof count>>().toEqualTypeOf<
    Throttled | EveryCallFailure
  >();
  expectTypeOf<Effect.Services<typeof count>>().toEqualTypeOf<never>();
});

const failingFetched = ActionHttp.fetchClient(Throttling, {
  transformClient: (client) =>
    HttpClient.mapRequestEffect(client, () =>
      Effect.fail(new SignInRequired())
    ),
});

expectTypeOf<
  Effect.Error<ReturnType<typeof failingFetched.count>>
>().toEqualTypeOf<Throttled | SignInRequired | EveryCallFailure>();

expectTypeOf<
  Effect.Services<ReturnType<typeof failingFetched.count>>
>().toEqualTypeOf<never>();

const authorizedFetched = ActionHttp.fetchClient(Throttling, {
  transformClient: authorizing,
});

expectTypeOf<
  Effect.Services<ReturnType<typeof authorizedFetched.count>>
>().toEqualTypeOf<Credentials>();
