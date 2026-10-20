import { DurableObject } from "cloudflare:workers";
import { Data, Effect, Layer } from "effect";
import { HttpRouter, HttpServer } from "effect/http";
import * as ActionDurableObject from "../src/durable/ActionDurableObject.js";
import {
  alarm,
  Builds,
  buildsAlarm,
  buildsRoutes,
  ownSocketRoutes,
  ownTag,
  prefixedRoutes,
  routerProvidedRoutes,
  routes,
  socketRoutes,
  startup,
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

export class Room extends ActionDurableObject.make({
  services: startup,
  routes: socketRoutes,
  alarm: () => alarm,
}) {}

export class Extended extends ActionDurableObject.make({
  services: startup,
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

export class BrokenServices extends ActionDurableObject.make({
  services: Layer.effectDiscard(Effect.fail(new Unreachable({ store: "services" }))),
  routes: Layer.empty,
}) {}

export class Counted extends ActionDurableObject.make({
  services: Builds.layer,
  routes: buildsRoutes,
  alarm: () => buildsAlarm,
}) {
  builds() {
    return this.run(Effect.service(Builds));
  }

  providedBuilds() {
    return this.run(Effect.provide(Effect.service(Builds), Builds.layer));
  }
}

export class OwnSockets extends ActionDurableObject.make({
  services: startup,
  routes: ownSocketRoutes,
}) {
  override webSocketMessage(socket: WebSocket, message: string | ArrayBuffer) {
    if (!this.ctx.getTags(socket).includes(ownTag)) return super.webSocketMessage(socket, message);

    socket.send(message);

    return Promise.resolve();
  }
}

export default { fetch: () => new Response(null, { status: 404 }) };
