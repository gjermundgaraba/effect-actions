import { Effect, type Layer, Schema } from "effect";
import type { HttpRouter } from "effect/http";
import { expectTypeOf } from "@effect/vitest";
import * as Action from "../../src/contract/Action.js";
import * as ActionHttp from "../../src/http/ActionHttp.js";
import * as ActionToolkit from "../../src/toolkit/ActionToolkit.js";
import * as Authentication from "../../src/authentication/Authentication.js";
import { Caller, type NumberedHandlers, type Numbering, Throttled } from "../support/numbered.js";

type Sixty = Numbering<60, 3>;

type FourHundred = Numbering<400, 6>;

type TwoHundred = Numbering<200, 6>;

const Login = Authentication.make("large.Login", Caller);

export const largeAuthorizationTypes = (
  sixty: Sixty,
  sixtyHandlers: NumberedHandlers<Sixty>,
  fourHundred: FourHundred,
  fourHundredHandlers: NumberedHandlers<FourHundred>,
  fourHundredArray: ReadonlyArray<FourHundred[number]>,
  twoHundred: TwoHundred,
) => {
  type Declared = Sixty[number]["error"][number]["Type"];

  expectTypeOf<Extract<Declared, Throttled>>().toEqualTypeOf<Throttled>();
  expectTypeOf<Exclude<Declared, Throttled>["_tag"]>().toExtend<`${number}${"a" | "b" | "c"}`>();

  expectTypeOf<
    Effect.Error<ReturnType<Action.Authorize<Sixty[number]>>>
  >().toEqualTypeOf<Action.Refusal>();

  Action.implement(sixty, sixtyHandlers, { authorize: Action.allowAll });
  Action.implement(sixty, sixtyHandlers, {
    authorize: (action) => (action.readOnly ? Effect.void : Effect.fail(new Action.Forbidden())),
  });
  // @ts-expect-error -- The shared limit is the handler's to fail with, not authorization's.
  Action.implement(sixty, sixtyHandlers, { authorize: () => Effect.fail(new Throttled()) });
  Action.implement(sixty, sixtyHandlers, {
    // @ts-expect-error -- Nor an error of an action's own.
    authorize: () => Effect.fail(Schema.TaggedStruct("0a", {}).make({})),
  });

  const authorize: Action.Authorize<FourHundred[number]> = (action) =>
    action.readOnly ? Effect.void : Effect.fail(new Action.Forbidden());

  Action.implement(fourHundred, fourHundredHandlers, {
    authorize: () => Effect.fail(new Action.Forbidden()),
  });
  Action.implement(fourHundredArray, fourHundredHandlers, {
    authorize: () => Effect.fail(new Action.Forbidden()),
  });
  Action.implement(fourHundred, fourHundredHandlers, { authorize });

  const app = Action.implement(fourHundred, fourHundredHandlers, { authorize: Action.allowAll });
  const routes = ActionHttp.layer(ActionHttp.make(fourHundred, { authentication: Login }), app);

  expectTypeOf<HttpRouter.Request.Only<"Requires", Layer.Services<typeof routes>>>().toBeNever();

  ActionHttp.layer(ActionHttp.make(twoHundred, { authentication: Login }), app);
  ActionToolkit.make(app);
  ActionToolkit.make(app, { actions: twoHundred });
};
