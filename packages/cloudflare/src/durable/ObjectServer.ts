import type * as Action from "@gjermundgaraba/effect-actions/Action";
import type * as Event from "@gjermundgaraba/effect-actions/Event";
import { Context, Effect, Layer, Scheduler } from "effect";
import type { Scope } from "effect";
import {
  HttpEffect,
  HttpMiddleware,
  HttpRouter,
  HttpServer,
} from "effect/http";
import type { HttpServerRequest } from "effect/http";

import { layerEvents } from "./events.js";
import { layerIdempotency } from "./idempotency.js";
import { Sockets } from "./sockets.js";
import { State } from "./state.js";

/**
 * The routes and sockets of one Durable Object, served by a class `ActionDurableObject.make`
 * does not build, such as one whose per-object services are a Layer its own base class builds:
 * its `fetch`, `webSocketMessage`, `webSocketClose` and `webSocketError` delegate to these
 * Effects, which `layer` builds once per object. `fetch` serves the routes, and each socket
 * handler hands its event to the protocol that accepted the socket, as `make`'s do.
 *
 * **Gotchas**
 *
 * - `fetch` runs the routes on the scheduler of the fiber that runs it, and nothing else of its context: run it on the one the object's other events run on, such as `new Scheduler.MixedScheduler("sync")`; a service a request needs is one the Layer was built with.
 * - A socket no protocol accepted, such as one the class accepted itself, is ignored by `webSocketMessage` and `webSocketError`, and `webSocketClose` only replies to its close: handle such a socket in the class, by its tags, before delegating.
 */
export class ObjectServer extends Context.Service<
  ObjectServer,
  {
    /** Answers `request` with the routes. */
    readonly fetch: (request: Request) => Effect.Effect<Response>;
    /** Hands a message on `socket` to the protocol that accepted it. */
    readonly webSocketMessage: (
      socket: WebSocket,
      message: string | ArrayBuffer
    ) => Effect.Effect<void>;
    /** Replies to the client's close with its `code` and `reason`, and tells the socket's protocol it closed. */
    readonly webSocketClose: (
      socket: WebSocket,
      code: number,
      reason: string,
      wasClean: boolean
    ) => Effect.Effect<void>;
    /** Tells the socket's protocol it failed, which ends it as a close does. */
    readonly webSocketError: (
      socket: WebSocket,
      error: unknown
    ) => Effect.Effect<void>;
  }
>()("effect-actions-cloudflare/ObjectServer") {}

type Provided =
  | Event.Events
  | Action.Idempotency
  | Sockets
  | HttpRouter.HttpRouter;

type ServedPerRequest = HttpServerRequest.HttpServerRequest | Scope.Scope;

/**
 * Builds `ObjectServer` for the object whose `State` it is given, with the services `make`
 * gives its routes, and outputs it beside that `Event.Events`, so a service built in the same
 * Layer, such as one publishing an event, reaches the sockets watching it: `Event.Events`
 * keeping its logs in the object's storage, `Action.Idempotency` keeping answers there, and
 * `Sockets`, which `ActionDurableObject.layerWebSocket` registers with. The routes, such as
 * `ActionRpc.layer` over `ActionDurableObject.layerWebSocket` and `ActionHttp.layer`, are served
 * as `HttpRouter.toWebHandler` serves them, each request with the context the Layer was built
 * in, and the logger unless `disableLogger`.
 *
 * **Gotchas**
 *
 * - A Layer is memoized by its identity, and so are the ones it builds from: two objects building it in one memo map share the first's sockets and logs, so give each object's build a memo map of its own, `Layer.buildWithMemoMap(layer, Layer.makeMemoMapUnsafe(), scope)`.
 * - The protocols' servers, which run a socket's calls, are forked as it builds: build it on the scheduler the object's events run on, such as `new Scheduler.MixedScheduler("sync")`.
 * - It provides no `Alarm`, `Tasks` or `Waits`, which need the object's alarm: routes requiring them, such as `layerWebhooks`, are `make`'s or `handlers`'.
 */
export const layer = <A, E, R>(
  routes: Layer.Layer<A, E, R>,
  options?: { readonly disableLogger?: boolean | undefined }
): Layer.Layer<
  ObjectServer | Event.Events,
  E,
  | State
  | Exclude<
      HttpRouter.Request.Without<R>,
      Provided | Layer.Success<typeof HttpServer.layerServices>
    >
  | Exclude<
      | HttpRouter.Request.Only<"Requires", R>
      | HttpRouter.Request.Only<"GlobalRequires", R>,
      Provided | A | HttpRouter.Provided | ServedPerRequest
    >
> => {
  const served = Layer.effect(ObjectServer)(
    Effect.gen(function* () {
      const context = yield* Effect.context<HttpRouter.HttpRouter | Sockets>();
      const sockets = Context.get(context, Sockets);

      const handler = HttpEffect.toWebHandlerWith<never, ServedPerRequest>(
        context
      )(
        Context.get(context, HttpRouter.HttpRouter).asHttpEffect(),
        options?.disableLogger === true ? undefined : HttpMiddleware.logger
      );

      return ObjectServer.of({
        fetch: (request) =>
          Effect.flatMap(Scheduler.Scheduler, (scheduler) =>
            Effect.promise(
              async () =>
                await handler(
                  request,
                  Context.make(Scheduler.Scheduler, scheduler)
                )
            )
          ),
        webSocketMessage: (socket, message) =>
          Effect.asVoid(sockets.message(socket, message)),
        webSocketClose: (socket, code, reason) =>
          Effect.asVoid(sockets.close(socket, code, reason)),
        webSocketError: (socket) => Effect.asVoid(sockets.error(socket)),
      });
    })
  );

  const requestMarked: Layer.Any = routes;

  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const erased = requestMarked as Layer.Layer<
    A,
    E,
    Provided | State | Layer.Success<typeof HttpServer.layerServices>
  >;

  return served.pipe(
    Layer.provide(
      erased.pipe(
        Layer.provide(HttpServer.layerServices),
        Layer.provideMerge(HttpRouter.layer)
      )
    ),
    Layer.provide(
      Layer.merge(
        Sockets.layer,
        Layer.unwrap(Effect.map(State, layerIdempotency))
      )
    ),
    Layer.provideMerge(layerEvents)
  );
};
