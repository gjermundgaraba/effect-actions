// Compile-only pins: a selection narrows a surface's types only when its `actions` are always
// given. Options whose `actions` may be absent select every action at run time, so they are
// typed as every action: they owe everything every action does.
import { Context, Effect, Layer, Schema } from "effect";
import { expectTypeOf } from "@effect/vitest";
import { Command } from "effect/cli";
import * as Action from "../src/Action.js";
import * as ActionCli from "../src/ActionCli.js";
import * as ActionMcp from "../src/ActionMcp.js";
import * as ActionToolkit from "../src/ActionToolkit.js";
import * as Authentication from "../src/Authentication.js";

class Actor extends Context.Service<Actor, { readonly id: string }>()("selection/Actor") {}

/** What only the protected action's built authorizer needs. */
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
  // Listed: the public action alone owes nothing of the protected one's.
  const listed = Action.client(mixed, { actions: [Public] });
  expectTypeOf<Effect.Services<typeof listed>>().toEqualTypeOf<import("effect").Scope.Scope>();

  // Unlisted: every action, the authorizer's `Boot` included.
  const every = Action.client(mixed);
  expectTypeOf<Boot>().toExtend<Effect.Services<typeof every>>();

  // Maybe listed, or listed by a condition: every action, as at run time it may be.
  const unsure = Action.client(mixed, maybe);
  expectTypeOf<Boot>().toExtend<Effect.Services<typeof unsure>>();
  // Its methods are only those present either way: the public one's, never the sibling's.
  expectTypeOf<Effect.Success<typeof unsure>>().toHaveProperty("open");
  expectTypeOf<Effect.Success<typeof unsure>>().not.toHaveProperty("guarded");
  const either = Action.client(mixed, listing ? { actions: [Public] } : {});
  expectTypeOf<Boot>().toExtend<Effect.Services<typeof either>>();
  expectTypeOf<Effect.Success<typeof either>>().not.toHaveProperty("guarded");

  // Explicit options listing actions require the argument, which alone holds the list.
  // @ts-expect-error The options listing actions are not given.
  Action.client<typeof mixed, { readonly actions: readonly [typeof Public] }>(mixed);

  // A misspelled option is refused beside a list, as without one.
  // @ts-expect-error No option `extra`.
  Action.client(mixed, { actions: [Public], extra: 1 });

  const stdio = ActionMcp.runStdio(mixed, { name: "t", version: "0", ...maybe });
  expectTypeOf<Boot>().toExtend<Effect.Services<typeof stdio>>();
  expectTypeOf<Actor>().toExtend<Effect.Services<typeof stdio>>();

  // Reusable stdio options, typed without the actions they may list, serve every action.
  const options: ActionMcp.Options<never, never, typeof Public> = { name: "t", version: "0" };
  const shared = ActionMcp.runStdio(mixed, options);
  expectTypeOf<Boot>().toExtend<Effect.Services<typeof shared>>();

  const cli = ActionCli.make(mixed, { name: "t", ...maybe });
  expectTypeOf<Boot>().toExtend<CommandServices<typeof cli>>();
  expectTypeOf<CommandServices<typeof cli>>().not.toBeUnknown();

  const endpoint = ActionMcp.layerHttp(open, { name: "t", version: "0", ...maybe });
  expectTypeOf<Layer.Services<typeof endpoint>>().not.toBeUnknown();

  // A Toolkit as a client: every action's requirements, and only the tools present either way.
  const tools = ActionToolkit.make(mixed, maybe);
  expectTypeOf<Boot>().toExtend<Layer.Services<typeof tools.layer>>();
  expectTypeOf<keyof typeof tools.toolkit.tools>().toEqualTypeOf<"open">();

  // Reusable Toolkit options, typed as the module exports them, are accepted; ones typed for
  // fewer actions are not, as their approval would read every action's calls.
  const reusable: ActionToolkit.Options<typeof Public | typeof Guarded> = {};
  ActionToolkit.make(mixed, reusable);
  const narrower: ActionToolkit.Options<typeof Public> = {};
  // @ts-expect-error Its approval reads only the public action's calls.
  ActionToolkit.make(mixed, narrower);

  // @ts-expect-error An action none of the implementations holds.
  Action.client(open, { actions: [Guarded] });

  // A misspelled option is refused beside a list, as it is without one.
  // @ts-expect-error No option `instrucions`.
  ActionMcp.runStdio(mixed, { name: "t", version: "0", actions: [Public], instrucions: "" });
  // @ts-expect-error No option `allowedOrigin`.
  ActionMcp.layerHttp(open, { name: "t", version: "0", actions: [Public], allowedOrigin: [] });
  // @ts-expect-error No option `descriptoin`.
  ActionCli.make(mixed, { name: "t", actions: [Public], descriptoin: "" });
  // @ts-expect-error No command `nope`.
  ActionCli.make(mixed, { name: "t", actions: [Public], commands: { nope: {} } });

  // A command for an action the list leaves out is unused: one record of commands serves
  // aggregates of several selections, and each owes what its listed actions owe.
  const bare = ActionCli.make(mixed, { name: "t", actions: [Public] });

  const unlisted = ActionCli.make(mixed, {
    name: "t",
    actions: [Public],
    commands: { guarded: {} },
  });

  expectTypeOf<CommandServices<typeof unlisted>>().toEqualTypeOf<CommandServices<typeof bare>>();

  // So is one in one member of a union of options.
  const commanded = listing
    ? { name: "t", actions: [Public], commands: { guarded: {} } }
    : { name: "t", actions: [Public] };

  const viaUnion = ActionCli.make(mixed, commanded);

  expectTypeOf<CommandServices<typeof viaUnion>>().toEqualTypeOf<CommandServices<typeof bare>>();

  const renamed = listing
    ? { name: "t", actions: [Public], commands: { open: { nmae: "o" } } }
    : { name: "t", actions: [Public] };

  // @ts-expect-error No command option `nmae`.
  ActionCli.make(mixed, renamed);

  // A misspelled key in one member of a union of options is refused too.
  const origins = listing
    ? { name: "t", version: "0", actions: [Public], allowedOrigins: ["https://app"] }
    : { name: "t", version: "0", actions: [Public], allowedOrigin: ["https://app"] };

  // @ts-expect-error No option `allowedOrigin`.
  ActionMcp.layerHttp(open, origins);

  // @ts-expect-error No command option `nmae`.
  ActionCli.make(mixed, { name: "t", actions: [Public], commands: { open: { nmae: "o" } } });
};

class Login extends Context.Service<Login, { readonly id: string }>()("selection/Login") {}

const Auth = Authentication.make("selection.Auth", Login);

export const explicitTypes = () => {
  // Explicit options listing actions require the argument, which alone holds the list.
  // @ts-expect-error The options listing actions are not given.
  ActionToolkit.make<typeof mixed, { readonly actions: readonly [typeof Public] }>(mixed);

  // A descriptor on public tools is owed as given: an explicit type argument cannot drop it.
  ActionMcp.layerHttp<typeof open>(open, {
    name: "t",
    version: "0",
    // @ts-expect-error Its provider would be owed by no type.
    authentication: Auth,
  });
  ActionMcp.layerHttp(open, { name: "t", version: "0", authentication: Auth });
};
