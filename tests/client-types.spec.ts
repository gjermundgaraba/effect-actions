// Compile-only assertions on `Action.client`, included by `vp check`.
import { Effect, Schema, type Scope } from "effect";
import { expectTypeOf } from "@effect/vitest";
import * as Action from "../src/Action.js";
import * as ActionHttp from "../src/ActionHttp.js";
import { actors, CurrentActor } from "../examples/authorization.js";
import { type Permissions, whoAmI as storedWhoAmI } from "../examples/authorization-built.js";
import { Http } from "../examples/binding.js";
import { GetUser, type User, type UserNotFound } from "../examples/contracts.js";
import { double, status, userActions } from "../examples/handlers.js";
import type { Users } from "../examples/users.js";

// Acquiring builds: it owes the builders' startup services and a scope, and fails as they do.
const acquired = Action.client(userActions);

expectTypeOf<Effect.Success<typeof acquired>>().toEqualTypeOf<Action.Client<typeof userActions>>();

expectTypeOf<Effect.Error<typeof acquired>>().toBeNever();

expectTypeOf<Effect.Services<typeof acquired>>().toEqualTypeOf<Users | Scope.Scope>();

export const methodTypes = Effect.gen(function* () {
  const users = yield* acquired;
  const renamed = users.renameUser({ id: "1", name: "Bea" });

  // The decoded success; the action's errors and the built-in ones, as an HTTP client decodes
  // them, without a transport's; and per call, what the handler and `authorize` read, and the
  // contract's identity.
  expectTypeOf<Effect.Success<typeof renamed>>().toEqualTypeOf<typeof User.Type>();
  expectTypeOf<Effect.Error<typeof renamed>>().toEqualTypeOf<UserNotFound | Action.BuiltIn>();
  expectTypeOf<Effect.Services<typeof renamed>>().toEqualTypeOf<CurrentActor>();

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

  expectTypeOf<Effect.Services<typeof who>>().toEqualTypeOf<CurrentActor>();
  expectTypeOf<Effect.Services<typeof provided>>().toBeNever();
});

// Several implementations: each method owes its own implementation's request services.
export const listTypes = Effect.gen(function* () {
  const many = Action.client([userActions, double, status]);
  const actions = yield* many;

  expectTypeOf<Effect.Services<typeof many>>().toEqualTypeOf<Users | Scope.Scope>();
  expectTypeOf<Effect.Services<ReturnType<typeof actions.status>>>().toBeNever();
  expectTypeOf<Effect.Services<ReturnType<typeof actions.double>>>().toEqualTypeOf<CurrentActor>();
  expectTypeOf<Effect.Success<ReturnType<typeof actions.double>>>().toEqualTypeOf<number>();
  expectTypeOf<Effect.Error<ReturnType<typeof actions.status>>>().toEqualTypeOf<Action.BuiltIn>();

  // A public action owing nothing per call runs as it is.
  const counted: { readonly service: string; readonly users: number } = yield* actions.status();

  void counted;
  // A transforming input takes its decoded type: a number, not the string it is sent as.
  void actions.double({ value: 21 });
  // @ts-expect-error The string is its encoding, which a caller never passes.
  void actions.double({ value: "21" });
});

// A built authorizer: what builds it is a startup service of the acquisition, what it reads per
// call the method's.
const stored = Action.client(storedWhoAmI);

export const builtHookTypes = Effect.gen(function* () {
  const client = yield* stored;
  const who = client.whoAmI();

  expectTypeOf<Effect.Services<typeof stored>>().toEqualTypeOf<Permissions | Scope.Scope>();
  expectTypeOf<Effect.Services<typeof who>>().toEqualTypeOf<CurrentActor>();
});

// A builder's failure is the acquisition's; calls never fail with it.
class Unavailable extends Schema.TaggedError<Unavailable>()("Unavailable", {}) {}

const Ping = Action.make("ping", {
  description: "Ping",
  readOnly: true,
  caller: Action.Anyone,
  success: Schema.Number,
});

const failing = Action.client(
  Action.implement(
    Ping,
    Effect.as(Effect.fail(new Unavailable()), () => Effect.succeed(1)),
  ),
);

export const buildErrorTypes = Effect.gen(function* () {
  const client = yield* failing;

  expectTypeOf<Effect.Error<typeof failing>>().toEqualTypeOf<Unavailable>();
  expectTypeOf<Effect.Error<ReturnType<typeof client.ping>>>().toEqualTypeOf<Action.BuiltIn>();
});

// A selection: its actions alone, its implementation's builder and authorization.
export const selectionTypes = Effect.gen(function* () {
  const selected = Action.client(userActions, { actions: [GetUser] });
  const client = yield* selected;
  const got = client.getUser({ id: "1" });

  expectTypeOf<Effect.Services<typeof selected>>().toEqualTypeOf<Users | Scope.Scope>();
  expectTypeOf<Effect.Services<typeof got>>().toEqualTypeOf<CurrentActor>();
  // @ts-expect-error A selection's client has only the selected actions.
  // oxlint-disable-next-line typescript/no-unsafe-call -- Compile-failure fixture: the rejected method yields an error type; nothing runs.
  void client.renameUser({ id: "1", name: "Bea" });
});

// A handler acquiring a resource owes no scope per call: each call has its own.
export const scopeTypes = Effect.gen(function* () {
  const client = yield* Action.client(
    Action.implement(Ping, () => Effect.acquireRelease(Effect.succeed(1), () => Effect.void)),
  );

  expectTypeOf<Effect.Services<ReturnType<typeof client.ping>>>().toBeNever();
});

/** A lookup through either client: its methods share one shape. */
const lookup = <E, R>(users: {
  readonly getUser: (input: { readonly id: string }) => Effect.Effect<typeof User.Type, E, R>;
}) => users.getUser({ id: "1" });

// Moving between an in-process and a remote caller changes the line acquiring it.
export const oneLineTypes = Effect.gen(function* () {
  const inProcess = lookup(yield* Action.client(userActions));
  const remote = lookup(yield* ActionHttp.client(Http));

  expectTypeOf<Effect.Services<typeof inProcess>>().toEqualTypeOf<CurrentActor>();
  expectTypeOf<Effect.Services<typeof remote>>().toBeNever();
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

  expectTypeOf<Effect.Services<typeof passed>>().toEqualTypeOf<Users | Scope.Scope>();
  expectTypeOf<Effect.Services<typeof unknownOwed>>().toBeUnknown();
  void helped;
};
