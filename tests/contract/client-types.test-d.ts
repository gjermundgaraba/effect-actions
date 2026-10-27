import { expectTypeOf } from "@effect/vitest";
import { Effect, Schema } from "effect";
import type { Scope } from "effect";

import * as Action from "../../src/contract/Action.js";
import * as ActionHttp from "../../src/http/ActionHttp.js";
import { whoAmI as storedWhoAmI } from "../support/app/authorization-built.js";
import type { Permissions } from "../support/app/authorization-built.js";
import { actors, CurrentActor } from "../support/app/authorization.js";
import { Http } from "../support/app/binding.js";
import { GetUser } from "../support/app/contracts.js";
import type { User, UserNotFound } from "../support/app/contracts.js";
import { double, status, userActions } from "../support/app/handlers.js";
import type { Users } from "../support/app/users.js";

const acquired = Action.client(userActions);

expectTypeOf<Effect.Success<typeof acquired>>().toEqualTypeOf<
  Action.Client<typeof userActions>
>();

expectTypeOf<Effect.Error<typeof acquired>>().toBeNever();

expectTypeOf<Effect.Services<typeof acquired>>().toEqualTypeOf<
  Users | Scope.Scope
>();

export const methodDecodedWithoutTransportOwingCaller = Effect.gen(
  function* () {
    const users = yield* acquired;
    const renamed = users.renameUser({ id: "1", name: "Bea" });

    expectTypeOf<Effect.Success<typeof renamed>>().toEqualTypeOf<
      typeof User.Type
    >();
    expectTypeOf<Effect.Error<typeof renamed>>().toEqualTypeOf<
      UserNotFound | Action.BuiltIn
    >();
    expectTypeOf<
      Effect.Services<typeof renamed>
    >().toEqualTypeOf<CurrentActor>();

    // @ts-expect-error -- An action with required input needs its argument.
    void users.getUser();
    void users
      .getUser({ id: "1" })
      // @ts-expect-error -- No transport: no `SchemaError` to catch, nor an `HttpClientError`.
      .pipe(Effect.catchTag("SchemaError", () => Effect.void));
    // @ts-expect-error -- Only the actions it was given.
    // oxlint-disable-next-line typescript/no-unsafe-call -- Compile-failure fixture: the rejected method yields an error type; nothing runs.
    void users.double({ value: 2 });
  }
);

export const callerOwedPerCallDespiteAcquisition = Effect.gen(function* () {
  const users = yield* acquired.pipe(
    Effect.provideService(CurrentActor, actors.alice)
  );

  const who = users.whoAmI();
  const provided = who.pipe(Effect.provideService(CurrentActor, actors.reader));

  expectTypeOf<Effect.Services<typeof who>>().toEqualTypeOf<CurrentActor>();
  expectTypeOf<Effect.Services<typeof provided>>().toBeNever();
});

export const eachMethodOwingItsOwnImplementations = Effect.gen(function* () {
  const many = Action.client([userActions, double, status]);
  const actions = yield* many;

  expectTypeOf<Effect.Services<typeof many>>().toEqualTypeOf<
    Users | Scope.Scope
  >();
  expectTypeOf<
    Effect.Services<ReturnType<typeof actions.status>>
  >().toBeNever();
  expectTypeOf<
    Effect.Services<ReturnType<typeof actions.double>>
  >().toEqualTypeOf<CurrentActor>();
  expectTypeOf<
    Effect.Success<ReturnType<typeof actions.double>>
  >().toEqualTypeOf<number>();
  expectTypeOf<
    Effect.Error<ReturnType<typeof actions.status>>
  >().toEqualTypeOf<Action.BuiltIn>();

  const publicActionOwingNothing: {
    readonly service: string;
    readonly users: number;
  } = yield* actions.status();

  void publicActionOwingNothing;
  void actions.double({ value: 21 });
  // @ts-expect-error -- The string is its encoding, which a caller never passes.
  void actions.double({ value: "21" });
});

const builtAuthorizerClient = Action.client(storedWhoAmI);

export const builtAuthorizerStartupAndPerCall = Effect.gen(function* () {
  const client = yield* builtAuthorizerClient;
  const who = client.whoAmI();

  expectTypeOf<Effect.Services<typeof builtAuthorizerClient>>().toEqualTypeOf<
    Permissions | Scope.Scope
  >();
  expectTypeOf<Effect.Services<typeof who>>().toEqualTypeOf<CurrentActor>();
});

class Unavailable extends Schema.TaggedError<
  Unavailable,
  { readonly brand: unique symbol }
>()("Unavailable", {}) {}

const Ping = Action.make("ping", {
  description: "Ping",
  readOnly: true,
  caller: Action.Anyone,
  success: Schema.Finite,
});

const failingBuilderClient = Action.client(
  Action.implement(
    Ping,
    Effect.as(Effect.fail(new Unavailable()), () => Effect.succeed(1))
  )
);

export const buildErrorOnAcquisitionNotCalls = Effect.gen(function* () {
  const client = yield* failingBuilderClient;

  expectTypeOf<
    Effect.Error<typeof failingBuilderClient>
  >().toEqualTypeOf<Unavailable>();
  expectTypeOf<
    Effect.Error<ReturnType<typeof client.ping>>
  >().toEqualTypeOf<Action.BuiltIn>();
});

export const selectionWithItsBuilderAndAuthorization = Effect.gen(function* () {
  const selected = Action.client(userActions, { actions: [GetUser] });
  const client = yield* selected;
  const got = client.getUser({ id: "1" });

  expectTypeOf<Effect.Services<typeof selected>>().toEqualTypeOf<
    Users | Scope.Scope
  >();
  expectTypeOf<Effect.Services<typeof got>>().toEqualTypeOf<CurrentActor>();
  // @ts-expect-error -- A selection's client has only the selected actions.
  // oxlint-disable-next-line typescript/no-unsafe-call -- Compile-failure fixture: the rejected method yields an error type; nothing runs.
  void client.renameUser({ id: "1", name: "Bea" });
});

export const noScopeOwedPerCall = Effect.gen(function* () {
  const client = yield* Action.client(
    Action.implement(Ping, () =>
      Effect.acquireRelease(Effect.succeed(1), () => Effect.void)
    )
  );

  expectTypeOf<Effect.Services<ReturnType<typeof client.ping>>>().toBeNever();
});

const lookupThroughEitherClient = <E, R>(users: {
  readonly getUser: (input: {
    readonly id: string;
  }) => Effect.Effect<typeof User.Type, E, R>;
}) => users.getUser({ id: "1" });

export const inProcessAndRemoteClientsFitOneHelper = Effect.gen(function* () {
  const inProcess = lookupThroughEitherClient(
    yield* Action.client(userActions)
  );

  const remote = lookupThroughEitherClient(yield* ActionHttp.client(Http));

  expectTypeOf<
    Effect.Services<typeof inProcess>
  >().toEqualTypeOf<CurrentActor>();
  expectTypeOf<Effect.Services<typeof remote>>().toBeNever();
});

export const genericHelperPassesRequirementsErasedOwesUnknown = <
  const Apps extends
    | Action.AnyImplementation
    | readonly Action.AnyImplementation[],
>(
  apps: Apps,
  erased: Action.AnyImplementation
) => {
  const passed = Action.client([userActions, double]);
  const helped = Action.client(apps);
  const unknownOwed = Action.client(erased);

  expectTypeOf<Effect.Services<typeof passed>>().toEqualTypeOf<
    Users | Scope.Scope
  >();
  expectTypeOf<Effect.Services<typeof unknownOwed>>().toBeUnknown();

  return helped;
};
