import { Context, Effect, type Layer, Schema } from "effect";
import { expectTypeOf } from "@effect/vitest";
import * as Action from "../../src/contract/Action.js";
import { CurrentActor } from "../../examples/authorization.js";
import { GetUser, RenameUser, type User, WhoAmI } from "../../examples/contracts.js";

const Actions = [GetUser, RenameUser, WhoAmI] as const;

const contracts = Action.byName(Actions);

type Name = keyof typeof contracts;

expectTypeOf<Name>().toEqualTypeOf<"getUser" | "renameUser" | "whoAmI">();

expectTypeOf(contracts.getUser).toEqualTypeOf(GetUser);

expectTypeOf<(typeof contracts)["renameUser"]["input"]["Type"]>().toEqualTypeOf<{
  readonly id: string;
  readonly name: string;
}>();

type Input<K extends Name> = (typeof contracts)[K]["input"]["Type"];

type Success<K extends Name> = (typeof contracts)[K]["success"]["Type"];

export const successSchemaUnderGenericName = <K extends Name>(
  name: K,
): (typeof contracts)[K]["success"] => contracts[name].success;

expectTypeOf<Input<"getUser">>().toEqualTypeOf<{ readonly id: string }>();

expectTypeOf<Success<"getUser">>().toEqualTypeOf<typeof User.Type>();

type WriteNames = {
  [K in Name]: (typeof contracts)[K]["readOnly"] extends false ? K : never;
}[Name];

expectTypeOf<WriteNames>().toEqualTypeOf<"renameUser">();

const byNameOfSpreadTuples = Action.byName([...Actions, ...([] as const)]);

expectTypeOf(byNameOfSpreadTuples).toEqualTypeOf(contracts);

declare const erased: ReadonlyArray<Action.Any>;

expectTypeOf(Action.byName(erased)).toEqualTypeOf<{ readonly [name: string]: Action.Any }>();

class Stale extends Schema.TaggedError<Stale>()("Stale", { message: Schema.String }) {}

declare const actor: Effect.Effect<{ readonly id: string; readonly tenantId: string }, Stale>;

declare const reader: Effect.Effect<
  { readonly id: string; readonly tenantId: string },
  Stale,
  CurrentActor
>;

const refuse = ({ message }: Stale) => Effect.fail(new Action.InvalidInput({ message }));

const Who = Action.make("who", {
  description: "",
  readOnly: true,
  caller: Action.Anyone,
  success: WhoAmI.success,
});

const Whom = Action.make("whom", {
  description: "",
  readOnly: true,
  caller: Action.Anyone,
  success: WhoAmI.success,
});

{
  const recordWithDataFirstAndPipedCatchTag = Action.implement([Who, Whom], {
    who: () => Effect.catchTag(actor, "Stale", refuse),
    whom: () => actor.pipe(Effect.catchTag("Stale", refuse)),
  });

  expectTypeOf<(typeof recordWithDataFirstAndPipedCatchTag)["~request"]["who"]>().toBeUnknown();

  expectTypeOf<(typeof recordWithDataFirstAndPipedCatchTag)["~request"]["whom"]>().toBeNever();
}

{
  const recordReadingActorEitherWay = Action.implement([Who, Whom], {
    who: () => Effect.orDie(reader),
    whom: () => reader.pipe(Effect.catchTag("Stale", refuse)),
  });

  expectTypeOf<
    (typeof recordReadingActorEitherWay)["~request"]["who"]
  >().toEqualTypeOf<CurrentActor>();
  expectTypeOf<
    (typeof recordReadingActorEitherWay)["~request"]["whom"]
  >().toEqualTypeOf<CurrentActor>();
}

{
  const singleActionWithDataFirstCatchTag = Action.implement(Who, () =>
    Effect.catchTag(actor, "Stale", refuse),
  );

  expectTypeOf<(typeof singleActionWithDataFirstCatchTag)["~request"]["who"]>().toBeNever();
}

export const servedDischargingGenericRequirement = <R>(
  handler: () => Effect.Effect<typeof WhoAmI.success.Type, never, R>,
  layer: Layer.Layer<R>,
): Promise<typeof WhoAmI.success.Type> => {
  const app = Action.implement([Who, Whom], { who: handler, whom: () => Effect.orDie(actor) });

  return Effect.runPromise(
    Effect.flatMap(Action.client(app), (client) => client.who()).pipe(
      Effect.provide(layer),
      Effect.scoped,
    ),
  );
};

const ReferenceWithDefault = Context.Reference<{ readonly id: string }>("spec/Defaulted", {
  defaultValue: () => ({ id: "anyone" }),
});

Action.make("byDefault", {
  description: "",
  readOnly: true,
  // @ts-expect-error -- An identity is a Context.Service, not a Context.Reference.
  caller: ReferenceWithDefault,
});

declare const misspelledInOneMember:
  | {
      readonly description: "";
      readonly readOnly: true;
      readonly caller: typeof Action.Anyone;
      readonly error: readonly [];
    }
  | {
      readonly description: "";
      readonly readOnly: true;
      readonly caller: typeof Action.Anyone;
      readonly errors: readonly [];
    };

// @ts-expect-error -- No option `errors`.
Action.make("typoInUnion", misspelledInOneMember);

export const builderWrittenApartFromImplement = () => {
  class Users extends Context.Service<Users, (id: string) => string>()("contract-types/Users") {}

  const actions = [GetUser, RenameUser] as const;

  const handlers = Effect.map(
    Effect.service(Users),
    (users) =>
      ({
        getUser: ({ id }) => Effect.succeed({ id, name: users(id) }),
        renameUser: ({ id, name }) => Effect.succeed({ id, name }),
      }) satisfies Action.Handlers<typeof actions>,
  );

  const remote = Action.implement(actions, handlers, { authorize: () => Effect.void });
  const trusted = Action.implement(actions, handlers, { authorize: Action.allowAll });

  expectTypeOf<Action.Handlers<readonly [typeof GetUser]>>().toEqualTypeOf<{
    readonly getUser: Action.Handler<typeof GetUser>;
  }>();

  // @ts-expect-error -- A handler of no listed action is refused.
  ({ deleteUser: () => Effect.void }) satisfies Action.Handlers<typeof actions>;

  return [remote, trusted];
};

class Missing extends Schema.TaggedError<Missing>()("Missing", {}) {}

class Taken extends Schema.TaggedError<Taken>()("Taken", {}) {}

const Owner = { caller: CurrentActor, error: [Missing, Taken] } as const;

const RenameWithSpreadOptions = Action.make("rename", {
  ...Owner,
  description: "Rename.",
  readOnly: false,
  input: { id: Schema.String },
});

const RenameInline = Action.make("rename", {
  caller: CurrentActor,
  error: [Missing, Taken],
  description: "Rename.",
  readOnly: false,
  input: { id: Schema.String },
});

expectTypeOf(RenameWithSpreadOptions).toEqualTypeOf(RenameInline);

class Other extends Schema.TaggedError<Other>()("Other", {}) {}

Action.implement(
  RenameWithSpreadOptions,
  // @ts-expect-error -- `Other` is no error `Owner` declares.
  () => Effect.fail(new Other()),
  { authorize: Action.allowAll },
);

expectTypeOf<typeof Action.Image.Type>().toEqualTypeOf<{
  readonly data: Uint8Array<ArrayBufferLike>;
  readonly mimeType: string;
}>();

expectTypeOf<typeof Action.Image.Encoded>().toEqualTypeOf<{
  readonly data: Uint8Array<ArrayBufferLike>;
  readonly mimeType: string;
}>();
