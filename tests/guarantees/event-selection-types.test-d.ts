import { expectTypeOf } from "@effect/vitest";
import { Context, Effect, Schema } from "effect";
import type { Layer, Scope } from "effect";
import type { Command } from "effect/cli";
import type { HttpRouter } from "effect/http";

import * as Authentication from "../../src/authentication/Authentication.js";
import * as ActionCli from "../../src/cli/ActionCli.js";
import * as Action from "../../src/contract/Action.js";
import * as Event from "../../src/contract/Event.js";
import * as ActionHttp from "../../src/http/ActionHttp.js";
import * as ActionMcp from "../../src/mcp/ActionMcp.js";
import * as ActionRpc from "../../src/rpc/ActionRpc.js";

class Actor extends Context.Service<Actor, { readonly id: string }>()(
  "event-selection/Actor"
) {}

class Boot extends Context.Service<Boot, true>()("event-selection/Boot") {}

class Spare extends Context.Service<Spare, true>()("event-selection/Spare") {}

class Feed extends Context.Service<Feed, true>()("event-selection/Feed") {}

const Ping = Action.make("ping", {
  description: "Ping",
  readOnly: true,
  caller: Action.Anyone,
  success: Schema.String,
});

const Pong = Action.make("pong", {
  description: "Pong",
  readOnly: true,
  caller: Action.Anyone,
  success: Schema.String,
});

const Ticked = Event.make("clock.ticked", {
  description: "Ticked",
  payload: { n: Schema.Int },
  caller: Action.Anyone,
});

const Changed = Event.make("user.changed", {
  description: "Changed",
  payload: {},
  caller: Actor,
});

const check = () => Effect.succeed({ cursor: "0", events: [] });

const ping = Action.implement(
  [Ping],
  Effect.as(Boot, { ping: () => Effect.succeed("pong") })
);

const pong = Action.implement(
  [Pong],
  Effect.as(Spare, { pong: () => Effect.succeed("ping") })
);

const clock = Event.implement(Ticked, Effect.as(Feed, { check }));

const changes = Event.implement(
  Changed,
  { check },
  { authorize: Event.allowAll }
);

export const inProcess = () => {
  const watching = Action.client([ping, pong, clock], { actions: [Ticked] });
  expectTypeOf<Effect.Services<typeof watching>>().toEqualTypeOf<
    Feed | Event.Events | Scope.Scope
  >();
  expectTypeOf<Effect.Success<typeof watching>>().toHaveProperty("watch");
  expectTypeOf<Effect.Success<typeof watching>>().not.toHaveProperty("ping");

  const calling = Action.client([ping, pong, clock], { actions: [Ping] });
  expectTypeOf<Effect.Services<typeof calling>>().toEqualTypeOf<
    Boot | Scope.Scope
  >();
  expectTypeOf<Effect.Success<typeof calling>>().not.toHaveProperty("watch");

  const both = Action.client([ping, pong, clock], { actions: [Ping, Ticked] });
  expectTypeOf<Effect.Services<typeof both>>().toEqualTypeOf<
    Boot | Feed | Event.Events | Scope.Scope
  >();

  // @ts-expect-error -- An event type none of the implementations holds.
  Action.client([ping, clock], { actions: [Changed] });
};

export const overHttp = () => {
  const Http = ActionHttp.make([Ping, Pong, Ticked]);

  const routes = ActionHttp.layer(Http, [ping, pong, clock], {
    actions: [Ping, Ticked],
  });

  expectTypeOf<Boot | Feed>().toExtend<Layer.Services<typeof routes>>();
  expectTypeOf<Spare>().not.toExtend<Layer.Services<typeof routes>>();

  const actionsAlone = ActionHttp.layer(Http, [ping, pong, clock], {
    actions: [Ping],
  });

  expectTypeOf<Feed>().not.toExtend<Layer.Services<typeof actionsAlone>>();
};

export const overRpc = () => {
  const Rpc = ActionRpc.make([Ping, Pong, Ticked]);

  const rpcs = ActionRpc.layer(Rpc, [ping, pong, clock], {
    actions: [Ping, Ticked],
  });

  expectTypeOf<Boot | Feed>().toExtend<Layer.Services<typeof rpcs>>();
  expectTypeOf<Spare>().not.toExtend<Layer.Services<typeof rpcs>>();

  const eventsAlone = ActionRpc.layer(Rpc, [ping, pong, clock], {
    actions: [Ticked],
  });

  expectTypeOf<Boot>().not.toExtend<Layer.Services<typeof eventsAlone>>();
};

export const overMcp = () => {
  const endpoint = ActionMcp.layerHttp([ping, clock, changes], {
    name: "t",
    version: "0",
    actions: [Ping],
  });

  expectTypeOf<Feed>().not.toExtend<Layer.Services<typeof endpoint>>();

  // @ts-expect-error -- A protected event type is listed, and no authentication is given.
  ActionMcp.layerHttp([ping, clock, changes], {
    name: "t",
    version: "0",
    actions: [Changed],
  });

  const stdio = ActionMcp.runStdio([ping, clock], {
    name: "t",
    version: "0",
    actions: [Ticked],
  });

  expectTypeOf<Boot>().not.toExtend<Effect.Services<typeof stdio>>();
  expectTypeOf<Feed>().toExtend<Effect.Services<typeof stdio>>();
};

export const asCommands = () => {
  const local = ActionCli.make([ping, clock], { name: "t", actions: [Ping] });
  expectTypeOf<Feed>().not.toExtend<Command.Services<typeof local>>();
  expectTypeOf<Boot>().toExtend<Command.Services<typeof local>>();

  const watching = ActionCli.make([ping, clock], {
    name: "t",
    actions: [Ticked],
    // @ts-expect-error -- No command for an event type.
    commands: { "clock.ticked": {} },
  });

  expectTypeOf(watching).not.toBeNever();
};

class Polls extends Context.Service<Polls, true>()("event-selection/Polls") {}

class Reads extends Context.Service<Reads, true>()("event-selection/Reads") {}

export const oneImplementation = () => {
  const sources = {
    "clock.ticked": {
      check: () => Effect.as(Polls, { cursor: "0", events: [] }),
    },
    "user.changed": {
      check: () => Effect.as(Reads, { cursor: "0", events: [] }),
    },
  };

  const written = Event.implement([Ticked, Changed], sources, {
    authorize: Event.allowAll,
  });

  const built = Event.implement([Ticked, Changed], Effect.as(Boot, sources), {
    authorize: Event.allowAll,
  });

  const Http = ActionHttp.make([Ticked]);

  const routes = ActionHttp.layer(Http, [written], { actions: [Ticked] });
  expectTypeOf<HttpRouter.Request<"Requires", Polls>>().toExtend<
    Layer.Services<typeof routes>
  >();
  expectTypeOf<HttpRouter.Request<"Requires", Reads>>().not.toExtend<
    Layer.Services<typeof routes>
  >();
  expectTypeOf<HttpRouter.Request<"Requires", Actor>>().not.toExtend<
    Layer.Services<typeof routes>
  >();

  const builtRoutes = ActionHttp.layer(Http, [built], { actions: [Ticked] });
  expectTypeOf<Boot | HttpRouter.Request<"Requires", Polls>>().toExtend<
    Layer.Services<typeof builtRoutes>
  >();
  expectTypeOf<HttpRouter.Request<"Requires", Reads>>().not.toExtend<
    Layer.Services<typeof builtRoutes>
  >();
};

export const publicBesideProtected = () => {
  const Login = Authentication.make("event-selection.Login", Actor);

  const Open = Event.make("review.open", {
    description: "",
    payload: {},
    caller: Action.Anyone,
  });

  const Private = Event.make("review.private", {
    description: "",
    payload: {},
    caller: Actor,
  });

  const reviews = Event.implement(
    [Open, Private],
    {
      "review.open": {
        check: () => Effect.as(Actor, { cursor: "0", events: [] }),
      },
      "review.private": {
        check: () => Effect.succeed({ cursor: "0", events: [] }),
      },
    },
    { authorize: Event.allowAll }
  );

  const http = ActionHttp.layer(
    ActionHttp.make([Open, Private], { authentication: Login }),
    reviews
  );

  expectTypeOf<HttpRouter.Request<"Requires", Actor>>().toExtend<
    Layer.Services<typeof http>
  >();

  const rpc = ActionRpc.layer(
    ActionRpc.make([Open, Private], { authentication: Login }),
    reviews
  );

  expectTypeOf<HttpRouter.Request<"Requires", Actor>>().toExtend<
    Layer.Services<typeof rpc>
  >();

  const Job = Action.make("job", {
    description: "",
    readOnly: true,
    caller: Actor,
  });

  const job = Action.implement(Job, () => Effect.void, {
    authorize: Action.allowAll,
  });

  const opened = Event.implement(Open, {
    check: () => Effect.as(Actor, { cursor: "0", events: [] }),
  });

  const beside = ActionHttp.layer(
    ActionHttp.make([Open, Job], { authentication: Login }),
    [opened, job]
  );

  expectTypeOf<HttpRouter.Request<"Requires", Actor>>().toExtend<
    Layer.Services<typeof beside>
  >();

  const besideRpc = ActionRpc.layer(
    ActionRpc.make([Open, Job], { authentication: Login }),
    [opened, job]
  );

  expectTypeOf<HttpRouter.Request<"Requires", Actor>>().toExtend<
    Layer.Services<typeof besideRpc>
  >();
};
