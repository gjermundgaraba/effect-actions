// Compile-only assertions on `Action.client`, included by `vp check`.
import { Effect, Schema, type Scope } from "effect";
import * as Action from "../src/Action.js";
import * as ActionHttp from "../src/ActionHttp.js";
import { actors, CurrentActor } from "../examples/authorization.js";
import { type Permissions, whoAmI as storedWhoAmI } from "../examples/authorization-built.js";
import { Http } from "../examples/binding.js";
import { GetUser, type User, type UserNotFound } from "../examples/contracts.js";
import { double, status, userActions } from "../examples/handlers.js";
import type { Users } from "../examples/users.js";
import type { Equal } from "./equal.js";

// Acquiring builds: it owes the builders' startup services and a scope, and fails as they do.
const acquired = Action.client(userActions);

export const acquisitionTypes: [
  Equal<Effect.Success<typeof acquired>, Action.Client<typeof userActions>>,
  Equal<Effect.Error<typeof acquired>, never>,
  Equal<Effect.Services<typeof acquired>, Users | Scope.Scope>,
] = [true, true, true];

export const methodTypes = Effect.gen(function* () {
  const users = yield* acquired;
  const renamed = users.renameUser({ id: "1", name: "Bea" });

  // The decoded success; the action's errors and the built-in ones, as an HTTP client decodes
  // them, without a transport's; and per call, what the handler and the hook read.
  const renameTypes: [
    Equal<Effect.Success<typeof renamed>, typeof User.Type>,
    Equal<Effect.Error<typeof renamed>, UserNotFound | Action.BuiltIn>,
    Equal<Effect.Services<typeof renamed>, CurrentActor>,
  ] = [true, true, true];

  void renameTypes;

  // @ts-expect-error An action with required input needs its argument.
  void users.getUser();
  // @ts-expect-error No transport: no `SchemaError` to catch, nor an `HttpClientError`.
  void users.getUser({ id: "1" }).pipe(Effect.catchTag("SchemaError", () => Effect.void));
  // @ts-expect-error Only the actions it was given.
  // oxlint-disable-next-line typescript/no-unsafe-call -- Compile-failure fixture: the rejected method yields an error type; nothing runs.
  void users.double({ value: 2 });
});

// The caller is per call: provided around the acquisition, it is still owed by every call.
export const callerTypes = Effect.gen(function* () {
  const users = yield* acquired.pipe(Effect.provideService(CurrentActor, actors.alice));
  const who = users.whoAmI();
  const provided = who.pipe(Effect.provideService(CurrentActor, actors.reader));

  const owed: [
    Equal<Effect.Services<typeof who>, CurrentActor>,
    Equal<Effect.Services<typeof provided>, never>,
  ] = [true, true];

  void owed;
});

// Several implementations: each method owes its own implementation's request services.
export const listTypes = Effect.gen(function* () {
  const many = Action.client([userActions, double, status]);
  const actions = yield* many;

  const types: [
    Equal<Effect.Services<typeof many>, Users | Scope.Scope>,
    Equal<Effect.Services<ReturnType<typeof actions.status>>, never>,
    Equal<Effect.Services<ReturnType<typeof actions.double>>, CurrentActor>,
    Equal<Effect.Success<ReturnType<typeof actions.double>>, number>,
    Equal<Effect.Error<ReturnType<typeof actions.status>>, Action.BuiltIn>,
  ] = [true, true, true, true, true];

  void types;

  // A public action owing nothing per call runs as it is.
  const counted: { readonly service: string; readonly users: number } = yield* actions.status();

  void counted;
  // A transforming input takes its decoded type: a number, not the string it is sent as.
  void actions.double({ value: 21 });
  // @ts-expect-error The string is its encoding, which a caller never passes.
  void actions.double({ value: "21" });
});

// A built hook: what builds it is a startup service of the acquisition, what it reads per call
// the method's.
const stored = Action.client(storedWhoAmI);

export const builtHookTypes = Effect.gen(function* () {
  const client = yield* stored;
  const who = client.whoAmI();

  const types: [
    Equal<Effect.Services<typeof stored>, Permissions | Scope.Scope>,
    Equal<Effect.Services<typeof who>, CurrentActor>,
  ] = [true, true];

  void types;
});

// A builder's failure is the acquisition's; calls never fail with it.
class Unavailable extends Schema.TaggedError<Unavailable>()("Unavailable", {}) {}

const Ping = Action.make("ping", { description: "Ping", access: "read", success: Schema.Number });

const failing = Action.client(
  Action.implement(
    Ping,
    Effect.as(Effect.fail(new Unavailable()), () => Effect.succeed(1)),
    Action.allowAll,
  ),
);

export const buildErrorTypes = Effect.gen(function* () {
  const client = yield* failing;

  const types: [
    Equal<Effect.Error<typeof failing>, Unavailable>,
    Equal<Effect.Error<ReturnType<typeof client.ping>>, Action.BuiltIn>,
  ] = [true, true];

  void types;
});

// A share: its actions alone, its hook's requirements, its source's builder.
export const shareTypes = Effect.gen(function* () {
  const trusted = Action.client(Action.share([GetUser], userActions, Action.allowAll));
  const client = yield* trusted;
  const got = client.getUser({ id: "1" });

  const types: [
    Equal<Effect.Services<typeof trusted>, Users | Scope.Scope>,
    // Its handler still reads the caller; its hook reads nothing.
    Equal<Effect.Services<typeof got>, CurrentActor>,
  ] = [true, true];

  void types;
  // @ts-expect-error A share's client has only the share's actions.
  // oxlint-disable-next-line typescript/no-unsafe-call -- Compile-failure fixture: the rejected method yields an error type; nothing runs.
  void client.renameUser({ id: "1", name: "Bea" });
});

// A hook's error that every action declares is each call's own declared error.
class RateLimited extends Schema.TaggedError<RateLimited>()("RateLimited", {}) {}

const Limited = Action.make("limited", {
  description: "Limited",
  access: "read",
  errors: [RateLimited],
});

export const hookErrorTypes = Effect.gen(function* () {
  const client = yield* Action.client(
    Action.implement(
      Limited,
      () => Effect.void,
      () => Effect.fail(new RateLimited()),
    ),
  );

  const limited: Equal<
    Effect.Error<ReturnType<typeof client.limited>>,
    RateLimited | Action.BuiltIn
  > = true;

  void limited;
});

// A handler acquiring a resource owes no scope per call: each call has its own.
export const scopeTypes = Effect.gen(function* () {
  const client = yield* Action.client(
    Action.implement(
      Ping,
      () => Effect.acquireRelease(Effect.succeed(1), () => Effect.void),
      Action.allowAll,
    ),
  );

  const scoped: Equal<Effect.Services<ReturnType<typeof client.ping>>, never> = true;

  void scoped;
});

/** A lookup through either client: its methods share one shape. */
const lookup = <E, R>(users: {
  readonly getUser: (input: { readonly id: string }) => Effect.Effect<typeof User.Type, E, R>;
}) => users.getUser({ id: "1" });

// Moving between an in-process and a remote caller changes the line acquiring it.
export const oneLineTypes = Effect.gen(function* () {
  const inProcess = lookup(yield* Action.client(userActions));
  const remote = lookup(yield* ActionHttp.client(Http));

  const types: [
    Equal<Effect.Services<typeof inProcess>, CurrentActor>,
    Equal<Effect.Services<typeof remote>, never>,
  ] = [true, true];

  void types;
});

// A helper generic over implementations passes their requirements on; an erased one owes
// `unknown`, which nothing provides.
export const genericTypes = <
  const Apps extends Action.AnyImplementation | ReadonlyArray<Action.AnyImplementation>,
>(
  apps: Apps,
  erased: Action.AnyImplementation,
) => {
  const passed = Action.client([userActions, double]);
  const helped = Action.client(apps);
  const unknownOwed = Action.client(erased);

  const types: [
    Equal<Effect.Services<typeof passed>, Users | Scope.Scope>,
    Equal<Effect.Services<typeof unknownOwed>, unknown>,
  ] = [true, true];

  void types;
  void helped;
};
