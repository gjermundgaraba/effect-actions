import { Array as Arr } from "effect";
import * as ActionHttp from "../../src/http/ActionHttp.js";
import * as ActionMcp from "../../src/mcp/ActionMcp.js";
import type * as Action from "../../src/contract/Action.js";
import { layer } from "../../examples/app.js";
import { serve } from "./serve.js";

export const makeTestApp = () => serve(layer);

type PublicAction = Action.Any & { readonly caller: typeof Action.Anyone };

type Free = Action.Implementation<
  PublicAction,
  { readonly [name: string]: never },
  unknown,
  never,
  unknown,
  never
>;

type Frees = Free | ReadonlyArray<Free>;

export const makeTestHttp = (apps: Frees, options?: ActionHttp.Options) =>
  serve(
    ActionHttp.layer(
      ActionHttp.make(
        Arr.ensure(apps).flatMap((app) => app.actions),
        options ?? {},
      ),
      apps,
    ),
  );

export const makeTestMcp = (apps: Frees) =>
  serve(ActionMcp.layerHttp(apps, { name: "test", version: "0" }));
