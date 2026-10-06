// Compile-only assertions over large implementations, included by `vp check`: a file of
// their own, checked beside the others rather than after them.
import { Effect, type Layer, Schema } from "effect";
import type { HttpRouter } from "effect/http";
import { expectTypeOf } from "@effect/vitest";
import * as Action from "../src/Action.js";
import * as ActionHttp from "../src/ActionHttp.js";
import * as ActionToolkit from "../src/ActionToolkit.js";
import * as Authentication from "../src/Authentication.js";
import { Caller, Limited, type NumberedHandlers, type Numbering, Throttled } from "./numbered.js";

/** Sixty protected actions of four errors each. */
type Sixty = Numbering<60, 3>;

/** Four hundred protected actions of seven errors each. */
type FourHundred = Numbering<400, 6>;

/** The first two hundred of them. */
type TwoHundred = Numbering<200, 6>;

/** How a remote caller of the large fixtures proves it is `Caller`. */
const Login = Authentication.make("large.Login", Caller);

export const largeAuthorizationTypes = (
  sixty: Sixty,
  sixtyHandlers: NumberedHandlers<Sixty>,
  fourHundred: FourHundred,
  fourHundredHandlers: NumberedHandlers<FourHundred>,
  fourHundredArray: ReadonlyArray<FourHundred[number]>,
  twoHundred: TwoHundred,
) => {
  // The actions declare their own errors and their check's: one union, linear in the actions.
  type Declared = Sixty[number]["errors"][number]["Type"];

  expectTypeOf<Extract<Declared, Throttled>>().toEqualTypeOf<Throttled>();
  expectTypeOf<Exclude<Declared, Throttled>["_tag"]>().toExtend<`${number}${"a" | "b" | "c"}`>();

  // Whatever they declare, an authorizer only refuses.
  expectTypeOf<
    Effect.Error<ReturnType<Action.Authorize<Sixty[number]>>>
  >().toEqualTypeOf<Action.Refusal>();

  Action.implement(sixty, sixtyHandlers, { authorize: Action.allowAll });
  Action.implement(sixty, sixtyHandlers, {
    authorize: (action) =>
      action.access === "read" ? Effect.void : Effect.fail(new Action.Forbidden()),
  });
  // @ts-expect-error The limit every action declares is its check's to fail with, not authorization's.
  Action.implement(sixty, sixtyHandlers, { authorize: () => Effect.fail(new Throttled()) });
  Action.implement(sixty, sixtyHandlers, {
    // @ts-expect-error Nor an error of an action's own.
    authorize: () => Effect.fail(Schema.TaggedStruct("0a", {}).make({})),
  });

  // The check fails with what it declares alone, whatever else its actions declare.
  const own = () => Effect.fail(Schema.TaggedStruct("0a", {}).make({}));

  Action.check(Limited, () => Effect.fail(new Throttled()));
  // @ts-expect-error The first action declares it, the check does not.
  Action.check(Limited, own);

  // Four hundred actions, listed as a tuple or an array, behind an authorizer written inline
  // or annotated `Action.Authorize`.
  const authorize: Action.Authorize<FourHundred[number]> = (action) =>
    action.access === "read" ? Effect.void : Effect.fail(new Action.Forbidden());

  Action.implement(fourHundred, fourHundredHandlers, {
    authorize: () => Effect.fail(new Action.Forbidden()),
  });
  Action.implement(fourHundredArray, fourHundredHandlers, {
    authorize: () => Effect.fail(new Action.Forbidden()),
  });
  Action.implement(fourHundred, fourHundredHandlers, { authorize });

  // Surfaces over four hundred actions, serving all of them or half, authenticated over HTTP.
  const app = Action.implement(fourHundred, fourHundredHandlers, { authorize: Action.allowAll });
  const routes = ActionHttp.layer(ActionHttp.make(fourHundred, { authentication: Login }), app);

  // The check is built with the layer; the caller its callback reads, authentication provides.
  expectTypeOf<Extract<Layer.Services<typeof routes>, Limited>>().toEqualTypeOf<Limited>();
  expectTypeOf<HttpRouter.Request.Only<"Requires", Layer.Services<typeof routes>>>().toBeNever();

  ActionHttp.layer(ActionHttp.make(twoHundred, { authentication: Login }), app);
  ActionToolkit.make(app);
  ActionToolkit.make(app, { actions: twoHundred });
};
