import { Array as Arr } from "effect";

import type * as Action from "../../src/contract/Action.js";
import * as ActionHttp from "../../src/http/ActionHttp.js";
import * as ActionMcp from "../../src/mcp/ActionMcp.js";
import { layer } from "./app/app.js";
import { serve } from "./serve.js";

export const makeTestApp = () => serve(layer);

type PublicAction = Action.Any & { readonly caller: typeof Action.Anyone };

type Free<E> = Action.Implementation<
  PublicAction,
  { readonly [name: string]: never },
  E,
  never,
  unknown
>;

type Frees<E> = Free<E> | ReadonlyArray<Free<E>>;

export const makeTestHttp = <E>(apps: Frees<E>, options?: ActionHttp.Options) =>
  serve(
    ActionHttp.layer(
      ActionHttp.make(
        Arr.ensure(apps).flatMap((app) => app.actions),
        options ?? {}
      ),
      apps
    )
  );

export const makeTestMcp = <E>(apps: Frees<E>) =>
  serve(ActionMcp.layerHttp(apps, { name: "test", version: "0" }));
