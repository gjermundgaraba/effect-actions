import { DurableObject } from "cloudflare:workers";
import { Data, Effect, Layer } from "effect";
import { HttpRouter, HttpServer } from "effect/http";
import * as ActionDurableObject from "../src/durable/ActionDurableObject.js";
import {
  alarm,
  prefixedRoutes,
  routerProvidedRoutes,
  routes,
  socketRoutes,
} from "./support/app.js";

export class Plain extends DurableObject {
  readonly web = HttpRouter.toWebHandler(
    routes.pipe(
      Layer.provide(Layer.succeed(ActionDurableObject.State, this.ctx)),
      Layer.provide(HttpServer.layerServices),
    ),
    { disableLogger: true },
  );

  override fetch(request: Request) {
    return this.web.handler(request);
  }
}

export class Room extends ActionDurableObject.make({ routes: socketRoutes, alarm: () => alarm }) {}

export class Extended extends ActionDurableObject.make({
  routes: socketRoutes,
  alarm: () => alarm,
}) {
  override async alarm(info?: AlarmInvocationInfo) {
    await this.ctx.storage.put("extended", true);
    await super.alarm?.(info);
  }
}

export class RouterProvided extends ActionDurableObject.make({ routes: routerProvidedRoutes }) {}

export class Prefixed extends ActionDurableObject.make({ routes: prefixedRoutes }) {}

export class Unreachable extends Data.TaggedError("Unreachable")<{ readonly store: string }> {}

export class Broken extends ActionDurableObject.make({
  routes: Layer.effectDiscard(Effect.fail(new Unreachable({ store: "notes" }))),
}) {}

export default { fetch: () => new Response(null, { status: 404 }) };
