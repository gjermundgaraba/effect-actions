import type { DurableObject } from "cloudflare:workers";
import { Context, Effect, Layer } from "effect";
import { HttpRouter, HttpServerResponse } from "effect/http";
import type { RpcServer } from "effect/rpc";
import { expectTypeOf } from "@effect/vitest";
import * as ActionHttp from "@gjermundgaraba/effect-actions/ActionHttp";
import * as ActionDurableObject from "../../src/durable/ActionDurableObject.js";
import { CurrentUser, Http, implementation, socketRoutes } from "../support/app.js";

expectTypeOf(ActionDurableObject.make({ routes: socketRoutes })).toEqualTypeOf<
  new (ctx: DurableObjectState, env: Cloudflare.Env) => ActionDurableObject.Instance
>();

expectTypeOf<ActionDurableObject.Instance>().toExtend<DurableObject<Cloudflare.Env>>();

expectTypeOf(ActionDurableObject.layerWebSocket({ path: "/rpc" })).toEqualTypeOf<
  Layer.Layer<RpcServer.Protocol, never, ActionDurableObject.State | HttpRouter.HttpRouter>
>();

ActionDurableObject.make({
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

export class WithCloseCode extends ActionDurableObject.make({ routes: socketRoutes }) {
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
