import { expectTypeOf } from "@effect/vitest";
import { Effect, Stream } from "effect";
import type { Layer } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import type { HttpClientError, HttpRouter } from "effect/http";
import { HttpApiMiddleware } from "effect/http-api";

import type * as Authentication from "../../src/authentication/Authentication.js";
import * as Action from "../../src/contract/Action.js";
import * as Event from "../../src/contract/Event.js";
import * as ActionHttp from "../../src/http/ActionHttp.js";
import {
  Login,
  Open,
  opened,
  Quota,
  Region,
  Ticked,
  ticks,
  Watched,
  watched,
  watchedPlainly,
} from "../support/event-types.js";
import type { Caller, Store } from "../support/event-types.js";

const Http = ActionHttp.make([Open, Watched, Ticked], {
  authentication: Login,
  error: [Quota],
});

expectTypeOf(Http.actions).toEqualTypeOf<ReadonlyArray<typeof Open>>();

expectTypeOf(Http.events).toEqualTypeOf<
  ReadonlyArray<typeof Watched | typeof Ticked>
>();

// @ts-expect-error -- A protected event is bound only with authentication.
ActionHttp.make([Watched]);

const served = ActionHttp.layer(Http, [opened, watched, ticks]);

expectTypeOf<
  HttpRouter.Request.Only<"Requires", Layer.Services<typeof served>>
>().toEqualTypeOf<Region>();

expectTypeOf<
  Store | Authentication.Provider<Caller, "events-types.Login">
>().toExtend<Layer.Services<typeof served>>();

const inline = ActionHttp.layer(ActionHttp.make([Ticked]), [
  Event.implement(Ticked, { log: { emit: Stream.never } }),
]);

expectTypeOf<
  HttpRouter.Request.Only<"Requires", Layer.Services<typeof inline>>
>().toBeNever();

class NeedsCaller extends HttpApiMiddleware.Service<
  NeedsCaller,
  { requires: Caller }
>()("http-events-types/NeedsCaller") {}

const protectedEventsThroughIdentityMiddleware = ActionHttp.layer(
  Http,
  [watchedPlainly],
  {
    actions: [Watched],
    middleware: [NeedsCaller],
  }
);

expectTypeOf<
  HttpRouter.Request.Only<
    "Requires",
    Layer.Services<typeof protectedEventsThroughIdentityMiddleware>
  >
>().toBeNever();

export const watchOverHttp = Effect.gen(function* () {
  const http = yield* ActionHttp.client(Http);
  const watching = http.watch(Watched, { id: "a" });

  expectTypeOf<Stream.Success<typeof watching>>().toEqualTypeOf<
    Event.Received<typeof Watched>
  >();
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
  void http.watch(
    // @ts-expect-error -- Only the binding's events.
    Event.make("x.y", { description: "", payload: {}, caller: Action.Anyone })
  );

  const bearer = yield* ActionHttp.client(Http, {
    transformClient: (client) =>
      HttpClient.mapRequestEffect(client, (request) =>
        Effect.as(Region, HttpClientRequest.bearerToken(request, "t0k"))
      ),
  });

  const ticked = bearer.watch(Ticked);

  expectTypeOf<Stream.Services<typeof ticked>>().toEqualTypeOf<Region>();
  expectTypeOf<HttpClientError.HttpClientError | Quota>().toExtend<
    Stream.Error<typeof ticked>
  >();

  // @ts-expect-error -- A binding listing no event type has no `watch`.
  void (yield* ActionHttp.client(ActionHttp.make([Open]))).watch;
});

export const watchFromBrowser = () => {
  const ticked = ActionHttp.fetchClient(Http).watch(Ticked);

  expectTypeOf<Stream.Services<typeof ticked>>().toBeNever();
};
