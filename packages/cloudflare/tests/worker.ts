import { DurableObject } from "cloudflare:workers";
import { Data, DateTime, Effect, Layer } from "effect";
import { HttpRouter, HttpServer } from "effect/http";
import * as ActionDurableObject from "../src/durable/ActionDurableObject.js";
import {
  alarm,
  Builds,
  buildsAlarm,
  buildsRoutes,
  Greeting,
  ownSocketRoutes,
  ownTag,
  prefixedRoutes,
  readyAtOnce,
  readyRoute,
  retriedRoutes,
  routerProvidedRoutes,
  routes,
  slowUpstream,
  socketRoutes,
  startup,
  stubCalls,
} from "./support/app.js";
import { Hosts, paneCalls, pluginCalls, PluginStore, streamCalls } from "./support/hosts.js";
import { nativeCalls } from "./support/native.js";
import { heldBuild } from "./support/latch.js";
import { builtOnSecondTry, racedCalls, yieldsPastTimer } from "./support/raced.js";
import { versionedRoutes } from "./support/versioned.js";

export class Plain extends DurableObject {
  readonly web = HttpRouter.toWebHandler(
    routes.pipe(
      Layer.provide(ActionDurableObject.Alarm.layer),
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
  services: () => startup,
  routes: socketRoutes,
  alarm: () => alarm,
}) {}

export class Extended extends ActionDurableObject.make({
  services: () => startup,
  routes: socketRoutes,
  alarm: () => alarm,
}) {
  override async alarm(info?: AlarmInvocationInfo) {
    await this.ctx.storage.put("extended", true);
    await super.alarm(info);
  }
}

export class RouterProvided extends ActionDurableObject.make({ routes: routerProvidedRoutes }) {}

export class Prefixed extends ActionDurableObject.make({ routes: prefixedRoutes }) {}

export class Unreachable extends Data.TaggedError("Unreachable")<{ readonly store: string }> {}

export class Broken extends ActionDurableObject.make({
  routes: Layer.effectDiscard(Effect.fail(new Unreachable({ store: "notes" }))),
}) {}

export class BrokenServices extends ActionDurableObject.make({
  services: () => Layer.effectDiscard(Effect.fail(new Unreachable({ store: "services" }))),
  routes: Layer.empty,
}) {}

export class Counted extends ActionDurableObject.make({
  services: () => Builds.layer,
  routes: buildsRoutes.pipe(Layer.provide(slowUpstream)),
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
  services: () => startup,
  routes: ownSocketRoutes,
}) {
  override webSocketMessage(socket: WebSocket, message: string | ArrayBuffer) {
    if (!this.ctx.getTags(socket).includes(ownTag)) return super.webSocketMessage(socket, message);

    socket.send(message);

    return Promise.resolve();
  }
}

export class Retried extends ActionDurableObject.make({
  services: () => Layer.mergeAll(startup, Builds.layer),
  routes: retriedRoutes,
}) {}

export class RetriedAtOnce extends ActionDurableObject.make({
  services: () => readyAtOnce,
  routes: readyRoute,
}) {}

export class Hosted extends DurableObject {
  readonly #object = ActionDurableObject.handlers(this.ctx, {
    services: Builds.layer,
    alarm: () => buildsAlarm,
  });

  override fetch(request: Request) {
    return this.#object.fetch(request);
  }

  override alarm(info?: AlarmInvocationInfo) {
    return this.#object.alarm(info);
  }

  builds() {
    return this.#object.run(Effect.service(Builds));
  }
}

export class PluginHost extends ActionDurableObject.make({
  services: () => PluginStore.layer,
  calls: pluginCalls,
}) {}

export class PaneHost extends ActionDurableObject.make({
  services: () => Hosts.layer,
  calls: paneCalls,
}) {}

export class Stubbed extends ActionDurableObject.make({
  services: () => startup,
  calls: stubCalls,
}) {}

export class Streamed extends ActionDurableObject.make({ calls: streamCalls }) {}

export class Native extends ActionDurableObject.make({ calls: nativeCalls }) {}

export class Raced extends ActionDurableObject.make({ calls: racedCalls }) {
  yieldsPastTimer() {
    return this.run(yieldsPastTimer);
  }
}

export class BuiltAgainRaced extends ActionDurableObject.make({
  services: () => builtOnSecondTry,
  calls: racedCalls,
}) {}

export class LatchedRaced extends ActionDurableObject.make({
  services: () => heldBuild,
  calls: racedCalls,
}) {}

export class Unserved extends ActionDurableObject.make({ calls: Layer.empty }) {}

export default { fetch: () => new Response(null, { status: 404 }) };

export class FromEnv extends ActionDurableObject.make({
  services: (env) => Layer.succeed(Greeting, env.GREETING),
}) {
  greeting() {
    return this.run(Effect.service(Greeting));
  }
}

export class Delegating extends DurableObject {
  readonly #object = ActionDurableObject.handlers(this.ctx, {
    services: PluginStore.layer,
    calls: pluginCalls,
  });

  effectActionsRpc(request: ActionDurableObject.StubRequest) {
    return this.#object.effectActionsRpc(request);
  }
}

export class Failing extends ActionDurableObject.make({
  alarm: () =>
    Effect.flatMap(ActionDurableObject.State, ({ storage }) =>
      Effect.promise(async () => {
        await storage.put("runs", ((await storage.get<number>("runs")) ?? 0) + 1);
      }),
    ).pipe(Effect.andThen(Effect.fail(new Unreachable({ store: "alarm" })))),
}) {
  arm() {
    return this.run(
      Effect.flatMap(DateTime.now, (now) =>
        ActionDurableObject.Alarm.use((alarm) => alarm.set(now)),
      ),
    );
  }

  runs() {
    return this.run(
      Effect.flatMap(ActionDurableObject.State, ({ storage }) =>
        Effect.promise(async () => (await storage.get<number>("runs")) ?? 0),
      ),
    );
  }
}

export class Versioned extends ActionDurableObject.make({ routes: versionedRoutes }) {}
