import { Context, Effect, type Layer, Schema, Stream } from "effect";
import { HttpClient, type HttpClientError, HttpClientRequest, type HttpRouter } from "effect/http";
import { expectTypeOf } from "@effect/vitest";
import * as Action from "../../src/contract/Action.js";
import * as Authentication from "../../src/authentication/Authentication.js";
import * as Event from "../../src/contract/Event.js";
import * as ActionHttp from "../../src/http/ActionHttp.js";

class Caller extends Context.Service<Caller, string>()("http-events-types/Caller") {}

class Store extends Context.Service<Store, string>()("http-events-types/Store") {}

class Region extends Context.Service<Region, string>()("http-events-types/Region") {}

class Quota extends Schema.TaggedError<Quota>()("Quota", {}, { httpApiStatus: 429 }) {}

const Login = Authentication.make("http-events-types.Login", Caller, {
  principal: (caller) => caller,
});

const Watched = Event.make("account.watched", {
  description: "",
  input: { id: Schema.String },
  payload: { by: Schema.String },
  caller: Caller,
});

const Ticked = Event.make("clock.ticked", {
  description: "",
  payload: { at: Schema.Finite },
  caller: Action.Anyone,
});

const Open = Action.make("open", { description: "", readOnly: true, caller: Action.Anyone });

const watched = Event.implement(
  Watched,
  Effect.as(Store, {
    check: () => Effect.as(Region, { cursor: "0", events: [] }),
  }),
  { authorize: Event.allowAll },
);

const ticks = Event.implement(Ticked, { log: { emit: Stream.never } });

const opened = Action.implement(Open, () => Effect.void);

const Http = ActionHttp.make([Open, Watched, Ticked], { authentication: Login, error: [Quota] });

expectTypeOf(Http.actions).toEqualTypeOf<ReadonlyArray<typeof Open>>();

expectTypeOf(Http.events).toEqualTypeOf<ReadonlyArray<typeof Watched | typeof Ticked>>();

// @ts-expect-error -- A protected event is bound only with authentication.
ActionHttp.make([Watched]);

const served = ActionHttp.layer(Http, [opened, watched, ticks]);

expectTypeOf<
  HttpRouter.Request.Only<"Requires", Layer.Services<typeof served>>
>().toEqualTypeOf<Region>();

expectTypeOf<Store | Authentication.Provider<Caller, "http-events-types.Login">>().toExtend<
  Layer.Services<typeof served>
>();

const inline = ActionHttp.layer(ActionHttp.make([Ticked]), [
  Event.implement(Ticked, { log: { emit: Stream.never } }),
]);

expectTypeOf<HttpRouter.Request.Only<"Requires", Layer.Services<typeof inline>>>().toBeNever();

export const watchOverHttp = Effect.gen(function* () {
  const http = yield* ActionHttp.client(Http);
  const watching = http.watch(Watched, { id: "a" });

  expectTypeOf<Stream.Success<typeof watching>>().toEqualTypeOf<Event.Received<typeof Watched>>();
  expectTypeOf<Stream.Error<typeof watching>>().toEqualTypeOf<
    ActionHttp.WatchError<typeof Watched, typeof Http>
  >();
  expectTypeOf<
    Extract<Stream.Error<typeof watching>, { readonly _tag: string }>["_tag"]
  >().toEqualTypeOf<
    | "SubscriptionError"
    | "InvalidInput"
    | "Unauthenticated"
    | "Forbidden"
    | "Quota"
    | "HttpClientError"
    | "SchemaError"
    | "SseError"
  >();
  expectTypeOf<Stream.Services<typeof watching>>().toBeNever();

  // @ts-expect-error -- Its input is the event's.
  void http.watch(Watched, { id: 1 });
  // @ts-expect-error -- Only the binding's events.
  void http.watch(Event.make("x.y", { description: "", payload: {}, caller: Action.Anyone }));

  const bearer = yield* ActionHttp.client(Http, {
    transformClient: (client) =>
      HttpClient.mapRequestEffect(client, (request) =>
        Effect.as(Region, HttpClientRequest.bearerToken(request, "t0k")),
      ),
  });

  const ticked = bearer.watch(Ticked);

  expectTypeOf<Stream.Services<typeof ticked>>().toEqualTypeOf<Region>();
  expectTypeOf<HttpClientError.HttpClientError | Quota>().toExtend<Stream.Error<typeof ticked>>();

  // @ts-expect-error -- A binding listing no event type has no `watch`.
  void (yield* ActionHttp.client(ActionHttp.make([Open]))).watch;
});

export const watchFromBrowser = () => {
  const ticked = ActionHttp.fetchClient(Http).watch(Ticked);

  expectTypeOf<Stream.Services<typeof ticked>>().toBeNever();
};
