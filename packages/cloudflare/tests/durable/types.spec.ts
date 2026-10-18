import type { DurableObject } from "cloudflare:workers";
import { Effect, type Layer } from "effect";
import { HttpRouter, HttpServerResponse } from "effect/http";
import type { RpcServer } from "effect/rpc";
import { expectTypeOf } from "@effect/vitest";
import * as ActionHttp from "@gjermundgaraba/effect-actions/ActionHttp";
import * as ActionDurableObject from "../../src/durable/ActionDurableObject.js";
import { CurrentUser, Http, implementation, Rpc, socketRoutes } from "../support/app.js";

expectTypeOf(ActionDurableObject.make({ routes: socketRoutes })).toEqualTypeOf<
  new (ctx: DurableObjectState, env: Cloudflare.Env) => ActionDurableObject.Instance
>();

expectTypeOf<ActionDurableObject.Instance>().toExtend<DurableObject<Cloudflare.Env>>();

expectTypeOf(ActionDurableObject.layerWebSocket(Rpc, { path: "/rpc" })).toEqualTypeOf<
  Layer.Layer<RpcServer.Protocol, never, ActionDurableObject.State | HttpRouter.HttpRouter>
>();

ActionDurableObject.make({
  routes: socketRoutes,
  alarm: () => Effect.asVoid(Effect.all([Effect.service(ActionDurableObject.State), Effect.scope])),
});

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
