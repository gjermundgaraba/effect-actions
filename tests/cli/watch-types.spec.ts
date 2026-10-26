import { Context, Effect, Schema, Stream } from "effect";
import type { Command } from "effect/cli";
import { HttpClient } from "effect/http";
import { expectTypeOf } from "@effect/vitest";
import * as Action from "../../src/contract/Action.js";
import * as ActionCli from "../../src/cli/ActionCli.js";
import * as Authentication from "../../src/authentication/Authentication.js";
import * as Event from "../../src/contract/Event.js";
import * as ActionHttp from "../../src/http/ActionHttp.js";

class Caller extends Context.Service<Caller, string>()("cli-watch-types/Caller") {}

class Store extends Context.Service<Store, string>()("cli-watch-types/Store") {}

class Region extends Context.Service<Region, string>()("cli-watch-types/Region") {}

class Unavailable extends Schema.TaggedError<Unavailable>()("Unavailable", {}) {}

const Login = Authentication.make("cli-watch-types.Login", Caller);

const Ticked = Event.make("clock.ticked", {
  description: "",
  payload: { at: Schema.Finite },
  caller: Action.Anyone,
});

const Watched = Event.make("account.watched", {
  description: "",
  payload: { by: Schema.String },
  caller: Caller,
});

const ticks = Event.implement(
  Ticked,
  Effect.as(Store, { check: () => Effect.as(Region, { cursor: "0", events: [] }) }),
);

const Open = Action.make("open", { description: "", readOnly: true, caller: Action.Anyone });

const opened = Action.implement(Open, () => Effect.void);

const local = ActionCli.make([opened, ticks], { name: "x" });

expectTypeOf<Command.Error<typeof local>>().toEqualTypeOf<
  ActionCli.UserError<Action.BuiltIn | Event.SubscriptionError>
>();

expectTypeOf<Command.Services<typeof local>>().toEqualTypeOf<Store | Region | Event.Events>();

const eventsAlone = ActionCli.make([Event.implement(Ticked, { log: { emit: Stream.never } })], {
  name: "x",
});

expectTypeOf<Command.Error<typeof eventsAlone>>().toEqualTypeOf<
  ActionCli.UserError<Action.BuiltIn | Event.SubscriptionError>
>();

expectTypeOf<Command.Services<typeof eventsAlone>>().toEqualTypeOf<Event.Events>();

const Http = ActionHttp.make([Open, Ticked, Watched], {
  authentication: Login,
  error: [Unavailable],
});

const remote = ActionCli.remote(Http, { name: "x" });

expectTypeOf<
  Extract<Command.Error<typeof remote>, ActionCli.UserError<unknown>>["cause"]["_tag"]
>().toEqualTypeOf<
  | "SubscriptionError"
  | "InvalidInput"
  | "Unauthenticated"
  | "Forbidden"
  | "Unavailable"
  | "HttpClientError"
  | "SchemaError"
  | "SseError"
>();

expectTypeOf<Command.Services<typeof remote>>().toEqualTypeOf<HttpClient.HttpClient>();

class Offline extends Schema.TaggedError<Offline>()("Offline", {}) {}

const EventsOnly = ActionHttp.make([Ticked]);

const transformed = ActionHttp.client(EventsOnly, {
  transformClient: HttpClient.mapRequestEffect((request) =>
    Effect.andThen(Region, Effect.fail(new Offline())).pipe(Effect.as(request)),
  ),
});

const remoteWith = ActionCli.remote(EventsOnly, { name: "x", client: transformed });

expectTypeOf<Command.Services<typeof remoteWith>>().toEqualTypeOf<HttpClient.HttpClient | Region>();

expectTypeOf<Offline>().toExtend<
  Extract<Command.Error<typeof remoteWith>, ActionCli.UserError<unknown>>["cause"]
>();
