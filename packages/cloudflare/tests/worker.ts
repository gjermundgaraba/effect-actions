import { DurableObject } from "cloudflare:workers";
import { Data, Deferred, Effect, Layer, ManagedRuntime } from "effect";
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
import { Announcer, feedCalls, feedRoutes, Gate, twoPathRoutes } from "./support/feed.js";
import { nativeCalls } from "./support/native.js";

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

export class Manual extends DurableObject {
  readonly #memoMap = Layer.makeMemoMapUnsafe();

  readonly #services = Layer.mergeAll(
    startup,
    ActionDurableObject.Sockets.layer,
    ActionDurableObject.Feed.layer,
    pluginCalls.pipe(
      Layer.provide(ActionDurableObject.layerStub()),
      Layer.provideMerge(ActionDurableObject.Calls.layer),
      Layer.provide(PluginStore.layer),
    ),
  ).pipe(Layer.provideMerge(Layer.succeed(ActionDurableObject.State, this.ctx)));

  readonly #runtime = ManagedRuntime.make(this.#services, { memoMap: this.#memoMap });

  readonly #routesBuilt = Deferred.makeUnsafe<void, unknown>();

  readonly #web = HttpRouter.toWebHandler(
    ownSocketRoutes.pipe(
      Layer.tap(() => Deferred.succeed(this.#routesBuilt, undefined)),
      Layer.tapCause((cause) => Deferred.failCause(this.#routesBuilt, cause)),
      Layer.provide([this.#services, HttpServer.layerServices]),
    ),
    { memoMap: this.#memoMap, disableLogger: true },
  );

  override fetch(request: Request) {
    return this.#web.handler(request);
  }

  #dispatch(event: (sockets: ActionDurableObject.Sockets["Service"]) => Effect.Effect<boolean>) {
    return this.#runtime.runPromise(
      Effect.andThen(Deferred.await(this.#routesBuilt), ActionDurableObject.Sockets.use(event)),
    );
  }

  override async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer) {
    if (!(await this.#dispatch((sockets) => sockets.message(socket, message)))) {
      socket.send(message);
    }
  }

  override async webSocketClose(socket: WebSocket, code: number, reason: string) {
    await this.#dispatch((sockets) => sockets.close(socket, code, reason));
  }

  override async webSocketError(socket: WebSocket) {
    await this.#dispatch((sockets) => sockets.error(socket));
  }

  effectActionsRpc(request: ActionDurableObject.StubRequest) {
    return this.#runtime.runPromise(ActionDurableObject.Calls.use((calls) => calls.call(request)));
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

export class Fed extends ActionDurableObject.make({
  services: () => Layer.merge(Announcer.layer, Gate.layer),
  routes: feedRoutes,
  calls: feedCalls,
}) {}

export class TwoPaths extends ActionDurableObject.make({
  services: () => Layer.merge(Announcer.layer, Gate.layer),
  routes: twoPathRoutes,
  calls: feedCalls,
}) {}
