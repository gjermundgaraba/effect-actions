import { Context, Effect, Layer, Schema } from "effect";
import { expectTypeOf } from "@effect/vitest";
import { Command } from "effect/cli";
import * as Action from "../../src/contract/Action.js";
import * as ActionCli from "../../src/cli/ActionCli.js";
import * as ActionMcp from "../../src/mcp/ActionMcp.js";
import * as ActionToolkit from "../../src/toolkit/ActionToolkit.js";
import * as Authentication from "../../src/authentication/Authentication.js";

class Actor extends Context.Service<Actor, { readonly id: string }>()("selection/Actor") {}

class Boot extends Context.Service<Boot, true>()("selection/Boot") {}

const Public = Action.make("open", {
  description: "Open",
  readOnly: true,
  caller: Action.Anyone,
  success: Schema.String,
});

const Guarded = Action.make("guarded", {
  description: "Guarded",
  readOnly: true,
  caller: Actor,
  success: Schema.String,
});

const mixed = Action.implement(
  [Public, Guarded],
  { open: () => Effect.succeed("open"), guarded: () => Effect.succeed("guarded") },
  { authorize: Effect.as(Boot, Action.allowAll) },
);

const open = Action.implement(Public, () => Effect.succeed("open"));

declare const maybe: { readonly actions?: ReadonlyArray<typeof Public> };

declare const listing: boolean;

type CommandServices<C> = C extends Command.Command<string, {}, {}, unknown, infer R> ? R : never;

export const selectionTypes = () => {
  const listed = Action.client(mixed, { actions: [Public] });
  expectTypeOf<Effect.Services<typeof listed>>().toEqualTypeOf<import("effect").Scope.Scope>();

  const every = Action.client(mixed);
  expectTypeOf<Boot>().toExtend<Effect.Services<typeof every>>();

  const unsure = Action.client(mixed, maybe);
  expectTypeOf<Boot>().toExtend<Effect.Services<typeof unsure>>();
  expectTypeOf<Effect.Success<typeof unsure>>().toHaveProperty("open");
  expectTypeOf<Effect.Success<typeof unsure>>().not.toHaveProperty("guarded");
  const either = Action.client(mixed, listing ? { actions: [Public] } : {});
  expectTypeOf<Boot>().toExtend<Effect.Services<typeof either>>();
  expectTypeOf<Effect.Success<typeof either>>().not.toHaveProperty("guarded");

  // @ts-expect-error -- The options listing actions are not given.
  Action.client<typeof mixed, { readonly actions: readonly [typeof Public] }>(mixed);

  // @ts-expect-error -- No option `extra`, beside a list as without one.
  Action.client(mixed, { actions: [Public], extra: 1 });

  const stdio = ActionMcp.runStdio(mixed, { name: "t", version: "0", ...maybe });
  expectTypeOf<Boot>().toExtend<Effect.Services<typeof stdio>>();
  expectTypeOf<Actor>().toExtend<Effect.Services<typeof stdio>>();

  const options: ActionMcp.Options<never, never, typeof Public> = { name: "t", version: "0" };
  const shared = ActionMcp.runStdio(mixed, options);
  expectTypeOf<Boot>().toExtend<Effect.Services<typeof shared>>();

  const cli = ActionCli.make(mixed, { name: "t", ...maybe });
  expectTypeOf<Boot>().toExtend<CommandServices<typeof cli>>();
  expectTypeOf<CommandServices<typeof cli>>().not.toBeUnknown();

  const endpoint = ActionMcp.layerHttp(open, { name: "t", version: "0", ...maybe });
  expectTypeOf<Layer.Services<typeof endpoint>>().not.toBeUnknown();

  const tools = ActionToolkit.make(mixed, maybe);
  expectTypeOf<Boot>().toExtend<Layer.Services<typeof tools.layer>>();
  expectTypeOf<keyof typeof tools.toolkit.tools>().toEqualTypeOf<"open">();

  const reusable: ActionToolkit.Options<typeof Public | typeof Guarded> = {};
  ActionToolkit.make(mixed, reusable);
  const narrower: ActionToolkit.Options<typeof Public> = {};
  // @ts-expect-error -- Its approval reads only the public action's calls.
  ActionToolkit.make(mixed, narrower);

  // @ts-expect-error -- An action none of the implementations holds.
  Action.client(open, { actions: [Guarded] });

  // @ts-expect-error -- No option `instrucions`, beside a list as without one.
  ActionMcp.runStdio(mixed, { name: "t", version: "0", actions: [Public], instrucions: "" });
  // @ts-expect-error -- No option `allowedOrigin`.
  ActionMcp.layerHttp(open, { name: "t", version: "0", actions: [Public], allowedOrigin: [] });
  // @ts-expect-error -- No option `descriptoin`.
  ActionCli.make(mixed, { name: "t", actions: [Public], descriptoin: "" });
  // @ts-expect-error -- No command `nope`.
  ActionCli.make(mixed, { name: "t", actions: [Public], commands: { nope: {} } });

  const bare = ActionCli.make(mixed, { name: "t", actions: [Public] });

  const unlisted = ActionCli.make(mixed, {
    name: "t",
    actions: [Public],
    commands: { guarded: {} },
  });

  expectTypeOf<CommandServices<typeof unlisted>>().toEqualTypeOf<CommandServices<typeof bare>>();

  const commanded = listing
    ? { name: "t", actions: [Public], commands: { guarded: {} } }
    : { name: "t", actions: [Public] };

  const viaUnion = ActionCli.make(mixed, commanded);

  expectTypeOf<CommandServices<typeof viaUnion>>().toEqualTypeOf<CommandServices<typeof bare>>();

  const renamed = listing
    ? { name: "t", actions: [Public], commands: { open: { nmae: "o" } } }
    : { name: "t", actions: [Public] };

  // @ts-expect-error -- No command option `nmae`.
  ActionCli.make(mixed, renamed);

  const origins = listing
    ? { name: "t", version: "0", actions: [Public], allowedOrigins: ["https://app"] }
    : { name: "t", version: "0", actions: [Public], allowedOrigin: ["https://app"] };

  // @ts-expect-error -- No option `allowedOrigin`, in one member of the union.
  ActionMcp.layerHttp(open, origins);

  // @ts-expect-error -- No command option `nmae`.
  ActionCli.make(mixed, { name: "t", actions: [Public], commands: { open: { nmae: "o" } } });
};

class Login extends Context.Service<Login, { readonly id: string }>()("selection/Login") {}

const Auth = Authentication.make("selection.Auth", Login);

export const explicitTypes = () => {
  // @ts-expect-error -- The options listing actions are not given.
  ActionToolkit.make<typeof mixed, { readonly actions: readonly [typeof Public] }>(mixed);

  ActionMcp.layerHttp<typeof open>(open, {
    name: "t",
    version: "0",
    // @ts-expect-error -- Its provider would be owed by no type.
    authentication: Auth,
  });
  ActionMcp.layerHttp(open, { name: "t", version: "0", authentication: Auth });
};
