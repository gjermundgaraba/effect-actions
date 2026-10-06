// Compile-only assertions on contracts by name and on a record's inferred requirements,
// included by `vp check`.
import { Context, Effect, type Layer, Schema } from "effect";
import { expectTypeOf } from "@effect/vitest";
import * as Action from "../src/Action.js";
import { CurrentActor } from "../examples/authorization.js";
import { GetUser, RenameUser, type User, WhoAmI } from "../examples/contracts.js";

const Actions = [GetUser, RenameUser, WhoAmI] as const;

const contracts = Action.byName(Actions);

type Name = keyof typeof contracts;

// Each name holds its own contract, not the list's union.
expectTypeOf<Name>().toEqualTypeOf<"getUser" | "renameUser" | "whoAmI">();

expectTypeOf(contracts.getUser).toEqualTypeOf(GetUser);

expectTypeOf<(typeof contracts)["renameUser"]["input"]["Type"]>().toEqualTypeOf<{
  readonly id: string;
  readonly name: string;
}>();

/** An action's input and success by name, as a helper taking a name reads them. */
type Input<K extends Name> = (typeof contracts)[K]["input"]["Type"];

type Success<K extends Name> = (typeof contracts)[K]["success"]["Type"];

// Under a generic name the contract still resolves: its schema is read without a cast.
export const successOf = <K extends Name>(name: K): (typeof contracts)[K]["success"] =>
  contracts[name].success;

expectTypeOf<Input<"getUser">>().toEqualTypeOf<{ readonly id: string }>();

expectTypeOf<Success<"getUser">>().toEqualTypeOf<typeof User.Type>();

/** The writes among them, by `readOnly`. */
type Write = { [K in Name]: (typeof contracts)[K]["readOnly"] extends false ? K : never }[Name];

expectTypeOf<Write>().toEqualTypeOf<"renameUser">();

// A spread of tuples is a tuple: every name is there.
const spread = Action.byName([...Actions, ...([] as const)]);

expectTypeOf(spread).toEqualTypeOf(contracts);

declare const erased: ReadonlyArray<Action.Any>;

// A list typed without its names keys by `string`.
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

// A record's handler whose Effect ends in a data-first `Effect.catchTag` infers no
// requirements: TypeScript reads `catchTag`'s `orElse` services, which no argument gives, from
// the record's own entry, not yet inferred, the constraint's `unknown`. Pinned as it is today,
// so a release of Effect or TypeScript that infers it is noticed, and the card's failure mode
// with it.
{
  const app = Action.implement([Who, Whom], {
    who: () => Effect.catchTag(actor, "Stale", refuse),
    whom: () => actor.pipe(Effect.catchTag("Stale", refuse)),
  });

  expectTypeOf<(typeof app)["~request"]["who"]>().toBeUnknown();

  // Written with `.pipe(...)`, the handler owes what it reads: here nothing.
  expectTypeOf<(typeof app)["~request"]["whom"]>().toBeNever();
}

// What a handler does read is kept either way, when TypeScript infers it.
{
  const app = Action.implement([Who, Whom], {
    who: () => Effect.orDie(reader),
    whom: () => reader.pipe(Effect.catchTag("Stale", refuse)),
  });

  expectTypeOf<(typeof app)["~request"]["who"]>().toEqualTypeOf<CurrentActor>();
  expectTypeOf<(typeof app)["~request"]["whom"]>().toEqualTypeOf<CurrentActor>();
}

// One action's handler is inferred in either form.
{
  const app = Action.implement(Who, () => Effect.catchTag(actor, "Stale", refuse));

  expectTypeOf<(typeof app)["~request"]["who"]>().toBeNever();
}

// A helper generic in what its handler reads serves a record with it and discharges the
// requirement with the layer it is given: nothing of the record's entry is left once the
// layer is provided.
export const served = <R>(
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

// A reference is never missing, so its default would authenticate every caller.
const Defaulted = Context.Reference<{ readonly id: string }>("spec/Defaulted", {
  defaultValue: () => ({ id: "anyone" }),
});

Action.make("byDefault", {
  description: "",
  readOnly: true,
  // @ts-expect-error An identity is a Context.Service, not a Context.Reference.
  caller: Defaulted,
});

// A misspelled option in one member of a union of options is refused too: it would drop a
// declared error.
declare const misspelled:
  | {
      readonly description: "";
      readonly readOnly: true;
      readonly caller: typeof Action.Anyone;
      readonly errors: readonly [];
    }
  | {
      readonly description: "";
      readonly readOnly: true;
      readonly caller: typeof Action.Anyone;
      readonly error: readonly [];
    };

// @ts-expect-error No option `error`.
Action.make("typoInUnion", misspelled);

// A builder written apart from `implement`, as another authorizer of the same handlers takes,
// types its handlers from their contracts through `Action.Handlers`.
export const handlersApart = () => {
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

  // @ts-expect-error A handler of no listed action is refused.
  ({ deleteUser: () => Effect.void }) satisfies Action.Handlers<typeof actions>;

  return [remote, trusted];
};
