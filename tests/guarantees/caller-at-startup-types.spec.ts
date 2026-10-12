import { Context, Effect, type Layer } from "effect";
import { expectTypeOf } from "@effect/vitest";
import * as Action from "../../src/contract/Action.js";
import * as ActionHttp from "../../src/http/ActionHttp.js";
import * as ActionMcp from "../../src/mcp/ActionMcp.js";
import * as ActionRpc from "../../src/rpc/ActionRpc.js";
import { type Actor, CurrentActor } from "../support/app/authorization.js";
import { Login } from "../support/app/binding.js";
import { WhoAmI } from "../support/app/contracts.js";

interface CallerAtStartup {
  readonly "A builder yields the caller, which a server has per request: yield it in a handler or an authorizer": {
    readonly caller: CurrentActor;
    readonly builderOf: "whoAmI";
  };
}

class SameShapeAsTheCaller extends Context.Service<SameShapeAsTheCaller, Actor>()(
  "caller-at-startup/SameShapeAsTheCaller",
) {}

const server = { name: "t", version: "0", authentication: Login } as const;

const builderYieldsCaller = Action.implement(
  WhoAmI,
  Effect.map(CurrentActor, (actor) => () => Effect.succeed(actor)),
  { authorize: Action.allowAll },
);

const overHttp = ActionHttp.layer(
  ActionHttp.make([WhoAmI], { authentication: Login }),
  builderYieldsCaller,
);

const overRpc = ActionRpc.layer(
  ActionRpc.make([WhoAmI], { authentication: Login }),
  builderYieldsCaller,
);

const overMcp = ActionMcp.layerHttp(builderYieldsCaller, server);

expectTypeOf<
  Extract<Layer.Services<typeof overHttp>, CallerAtStartup>
>().toEqualTypeOf<CallerAtStartup>();

expectTypeOf<
  Extract<Layer.Services<typeof overRpc>, CallerAtStartup>
>().toEqualTypeOf<CallerAtStartup>();

expectTypeOf<
  Extract<Layer.Services<typeof overMcp>, CallerAtStartup>
>().toEqualTypeOf<CallerAtStartup>();

expectTypeOf<Extract<Layer.Services<typeof overHttp>, CurrentActor>>().toBeNever();

expectTypeOf<Extract<Layer.Services<typeof overRpc>, CurrentActor>>().toBeNever();

expectTypeOf<Extract<Layer.Services<typeof overMcp>, CurrentActor>>().toBeNever();

const overStdio = ActionMcp.runStdio(builderYieldsCaller, { name: "t", version: "0" });

expectTypeOf<CurrentActor>().toExtend<Effect.Services<typeof overStdio>>();

expectTypeOf<Extract<Effect.Services<typeof overStdio>, CallerAtStartup>>().toBeNever();

const authorizerBuiltWithCaller = Action.implement(
  WhoAmI,
  () => Effect.map(CurrentActor, (actor) => actor),
  { authorize: Effect.map(CurrentActor, () => Action.allowAll) },
);

const authorizedAtStartup = ActionHttp.layer(
  ActionHttp.make([WhoAmI], { authentication: Login }),
  authorizerBuiltWithCaller,
);

expectTypeOf<
  Extract<Layer.Services<typeof authorizedAtStartup>, CallerAtStartup>
>().toEqualTypeOf<CallerAtStartup>();

const handlerYieldsCaller = Action.implement(
  WhoAmI,
  Effect.map(SameShapeAsTheCaller, () => () => Effect.map(CurrentActor, (actor) => actor)),
  { authorize: Action.allowAll },
);

const perRequest = ActionHttp.layer(
  ActionHttp.make([WhoAmI], { authentication: Login }),
  handlerYieldsCaller,
);

expectTypeOf<Extract<Layer.Services<typeof perRequest>, string>>().toBeNever();

expectTypeOf<SameShapeAsTheCaller>().toExtend<Layer.Services<typeof perRequest>>();
