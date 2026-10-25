import { Context, Effect, Schema, type Scope } from "effect";
import { expectTypeOf } from "@effect/vitest";
import * as Action from "../../src/contract/Action.js";
import * as Event from "../../src/contract/Event.js";

class Actor extends Context.Service<Actor, { readonly id: string }>()("event-selection/Actor") {}

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

const ping = Action.implement([Ping], Effect.as(Boot, { ping: () => Effect.succeed("pong") }));

const pong = Action.implement([Pong], Effect.as(Spare, { pong: () => Effect.succeed("ping") }));

const clock = Event.implement(Ticked, Effect.as(Feed, { check }));

export const inProcess = () => {
  const watching = Action.client([ping, pong, clock], { actions: [Ticked] });
  expectTypeOf<Effect.Services<typeof watching>>().toEqualTypeOf<
    Feed | Event.Events | Scope.Scope
  >();
  expectTypeOf<Effect.Success<typeof watching>>().toHaveProperty("watch");
  expectTypeOf<Effect.Success<typeof watching>>().not.toHaveProperty("ping");

  const calling = Action.client([ping, pong, clock], { actions: [Ping] });
  expectTypeOf<Effect.Services<typeof calling>>().toEqualTypeOf<Boot | Scope.Scope>();
  expectTypeOf<Effect.Success<typeof calling>>().not.toHaveProperty("watch");

  const both = Action.client([ping, pong, clock], { actions: [Ping, Ticked] });
  expectTypeOf<Effect.Services<typeof both>>().toEqualTypeOf<
    Boot | Feed | Event.Events | Scope.Scope
  >();

  // @ts-expect-error -- An event type none of the implementations holds.
  Action.client([ping, clock], { actions: [Changed] });
};
