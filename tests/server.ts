import * as ActionHttp from "../src/ActionHttp.js";
import * as ActionMcp from "../src/ActionMcp.js";
import type * as Action from "../src/Action.js";
import { type Implementation, toList } from "../src/internal/implementation.js";
import { layer } from "../examples/app.js";
import { serve } from "./serve.js";

// Each call builds fresh example state.
export const makeTestApp = () => serve(layer);

/** An implementation that owes nothing per request or to build, as `serve` requires. */
type Free = Implementation<
  Action.Any,
  { readonly [name: string]: never },
  unknown,
  never,
  unknown,
  never
>;

/** What the helpers serve: one free implementation, or a list of them. */
type Frees = Free | ReadonlyArray<Free>;

/**
 * Serve implementations over HTTP, from a binding of exactly their actions. A test whose
 * implementations owe services serves its routes itself.
 */
export const makeTestHttp = (apps: Frees, options?: Parameters<typeof ActionHttp.make>[1]) =>
  serve(
    ActionHttp.layer(
      ActionHttp.make(
        toList(apps).flatMap((app) => app.actions),
        options,
      ),
      apps,
    ),
  );

/** Serve implementations over MCP at `/mcp`, as `makeTestHttp` serves them over HTTP. */
export const makeTestMcp = (apps: Frees) =>
  serve(ActionMcp.layerHttp(apps, { name: "test", version: "0" }));
