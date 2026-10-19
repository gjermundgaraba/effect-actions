import { DurableObject } from "cloudflare:workers";
import { Data, Effect, Layer } from "effect";
import { HttpRouter, HttpServer } from "effect/http";
import * as ActionDurableObject from "../src/durable/ActionDurableObject.js";
import {
  alarm,
  Builds,
  buildsRoutes,
  ownSocketRoutes,
  ownTag,
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

export class Counted extends ActionDurableObject.make({ routes: buildsRoutes }) {
  builds() {
    return this.run(Effect.provide(Effect.service(Builds), Builds.layer));
  }
}

export class OwnSockets extends ActionDurableObject.make({ routes: ownSocketRoutes }) {
  override webSocketMessage(socket: WebSocket, message: string | ArrayBuffer) {
    if (!this.ctx.getTags(socket).includes(ownTag)) return super.webSocketMessage(socket, message);

    socket.send(message);

    return Promise.resolve();
  }
}

export default { fetch: () => new Response(null, { status: 404 }) };
