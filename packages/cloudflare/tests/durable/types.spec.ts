import type { DurableObject } from "cloudflare:workers";
import { Context, Effect, Layer } from "effect";
import { HttpRouter, HttpServerResponse } from "effect/http";
import type { RpcServer } from "effect/rpc";
import { expectTypeOf } from "@effect/vitest";
import * as ActionHttp from "@gjermundgaraba/effect-actions/ActionHttp";
import * as ActionDurableObject from "../../src/durable/ActionDurableObject.js";
import {
  Builds,
  buildsRoutes,
  CurrentUser,
  Http,
  implementation,
  routerProvidedRoutes,
  socketRoutes,
  startup,
} from "../support/app.js";

expectTypeOf(ActionDurableObject.make({ routes: routerProvidedRoutes })).toEqualTypeOf<
  new (ctx: DurableObjectState, env: Cloudflare.Env) => ActionDurableObject.Instance
>();

expectTypeOf<ActionDurableObject.Instance>().toExtend<DurableObject<Cloudflare.Env>>();

expectTypeOf(ActionDurableObject.layerWebSocket({ path: "/rpc" })).toEqualTypeOf<
  Layer.Layer<
    RpcServer.Protocol,
    never,
    ActionDurableObject.Sockets | ActionDurableObject.State | HttpRouter.HttpRouter
  >
>();

declare const ctx: DurableObjectState;

void Effect.runPromise(
  // @ts-expect-error -- A protocol registers with the instance's Sockets, which nothing here provides.
  Layer.build(
    ActionDurableObject.layerWebSocket({ path: "/rpc" }).pipe(
      Layer.provide([Layer.succeed(ActionDurableObject.State, ctx), HttpRouter.layer]),
    ),
  ).pipe(Effect.scoped),
);

expectTypeOf(ActionDurableObject.Sockets.layer).toEqualTypeOf<
  Layer.Layer<ActionDurableObject.Sockets, never, ActionDurableObject.State>
>();

expectTypeOf<ReturnType<ActionDurableObject.Sockets["Service"]["message"]>>().toEqualTypeOf<
  Effect.Effect<boolean>
>();

expectTypeOf(ActionDurableObject.handlers(ctx, { services: Builds.layer })).toEqualTypeOf<
  ActionDurableObject.Handlers<Builds>
>();

expectTypeOf(
  ActionDurableObject.handlers(ctx, { services: startup, routes: socketRoutes }),
).toEqualTypeOf<ActionDurableObject.Handlers<Layer.Success<typeof startup>>>();

expectTypeOf<Parameters<ActionDurableObject.Handlers["webSocketClose"]>>().toEqualTypeOf<
  Parameters<NonNullable<DurableObject<Cloudflare.Env>["webSocketClose"]>>
>();

expectTypeOf<Parameters<ActionDurableObject.Handlers["alarm"]>>().toEqualTypeOf<
  Parameters<NonNullable<DurableObject<Cloudflare.Env>["alarm"]>>
>();

declare const hosted: ActionDurableObject.Handlers<Builds>;

expectTypeOf(hosted.run(Effect.service(Builds))).toEqualTypeOf<Promise<number>>();

// @ts-expect-error -- A run has only the services the object was given.
void hosted.run(Effect.service(CurrentUser));

ActionDurableObject.handlers(ctx, {
  // @ts-expect-error -- The routes require startup services no Layer provides.
  routes: socketRoutes,
});

ActionDurableObject.handlers(ctx, {
  services: Builds.layer,
  // @ts-expect-error -- The alarm has no caller unless it names one itself.
  alarm: () => Effect.asVoid(Effect.service(CurrentUser)),
});

ActionDurableObject.make({
  services: startup,
  routes: socketRoutes,
  alarm: () => Effect.asVoid(Effect.all([Effect.service(ActionDurableObject.State), Effect.scope])),
});

class Merged extends Context.Service<Merged, number>()("test/Merged") {}

ActionDurableObject.make({
  routes: HttpRouter.add(
    "GET",
    "/merged",
    Effect.as(Effect.service(Merged), HttpServerResponse.empty()),
  ).pipe(Layer.provideMerge(Layer.succeed(Merged, 1))),
});

export class WithCloseCode extends ActionDurableObject.make({
  services: startup,
  routes: socketRoutes,
}) {
  override webSocketClose(socket: WebSocket, code: number, reason: string, wasClean: boolean) {
    return super.webSocketClose(socket, code, reason, wasClean);
  }
}

expectTypeOf<Parameters<ActionDurableObject.Instance["webSocketError"]>>().toEqualTypeOf<
  Parameters<NonNullable<DurableObject<Cloudflare.Env>["webSocketError"]>>
>();

ActionDurableObject.make({
  // @ts-expect-error -- A startup service other than State, here the descriptor's provider, is the routes' to provide.
  routes: ActionHttp.layer(Http, implementation),
});

ActionDurableObject.make({
  // @ts-expect-error -- A request-time service is provided per request by middleware or authentication, never by the object.
  routes: HttpRouter.add(
    "GET",
    "/caller",
    Effect.as(Effect.service(CurrentUser), HttpServerResponse.empty()),
  ),
});

ActionDurableObject.make({
  services: startup,
  routes: socketRoutes,
  // @ts-expect-error -- The alarm has no caller unless it names one itself.
  alarm: () => Effect.asVoid(Effect.service(CurrentUser)),
});

declare const instance: ActionDurableObject.Instance;

expectTypeOf(
  instance.run(Effect.as(Effect.all([Effect.service(ActionDurableObject.State), Effect.scope]), 1)),
).toEqualTypeOf<Promise<number>>();

// @ts-expect-error -- A run has no caller unless it names one itself.
void instance.run(Effect.service(CurrentUser));

ActionDurableObject.make({
  // @ts-expect-error -- The routes require startup services no Layer provides.
  routes: socketRoutes,
});

ActionDurableObject.make({
  // @ts-expect-error -- The services are built at startup, where no request has a caller.
  services: Layer.effect(Builds)(Effect.as(Effect.service(CurrentUser), 1)),
  routes: Layer.empty,
});

const WithServices = ActionDurableObject.make({ services: Builds.layer, routes: buildsRoutes });

declare const withServices: InstanceType<typeof WithServices>;

expectTypeOf(withServices.run(Effect.service(Builds))).toEqualTypeOf<Promise<number>>();

// @ts-expect-error -- A run has only the services the object was given.
void withServices.run(Effect.service(CurrentUser));

ActionDurableObject.make({
  services: Builds.layer,
  routes: buildsRoutes,
  alarm: () => Effect.asVoid(Effect.service(Builds)),
});
