import { DurableObject } from "cloudflare:workers";
import { Data, DateTime, Effect, Layer } from "effect";
import { HttpRouter, HttpServer, HttpServerResponse } from "effect/http";

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
import {
  note,
  revokedKey,
  say,
  setStatus,
  watchedRoutes,
} from "./support/events.js";
import {
  Hosts,
  paneCalls,
  pluginCalls,
  PluginStore,
  streamCalls,
} from "./support/hosts.js";
import { heldBuild } from "./support/latch.js";
import { nativeCalls } from "./support/native.js";
import { shelfCalls, shelfRoutes, shelves } from "./support/placed.js";
import {
  builtOnSecondTry,
  racedCalls,
  yieldsPastTimer,
} from "./support/raced.js";
import { versionedRoutes } from "./support/versioned.js";
import { heldTime, hook, hookedRoutes } from "./support/webhooks.js";

export class Plain extends DurableObject {
  readonly web = HttpRouter.toWebHandler(
    routes.pipe(
      Layer.provide(ActionDurableObject.Alarm.layer),
      Layer.provide(Layer.succeed(ActionDurableObject.State, this.ctx)),
      Layer.provide(HttpServer.layerServices)
    ),
    { disableLogger: true }
  );

  override async fetch(request: Request) {
    return await this.web.handler(request);
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

export class RouterProvided extends ActionDurableObject.make({
  routes: routerProvidedRoutes,
}) {}

export class Prefixed extends ActionDurableObject.make({
  routes: prefixedRoutes,
}) {}

export class Unreachable extends Data.TaggedError("Unreachable")<{
  readonly store: string;
}> {}

export class Broken extends ActionDurableObject.make({
  routes: Layer.effectDiscard(Effect.fail(new Unreachable({ store: "notes" }))),
}) {}

export class BrokenServices extends ActionDurableObject.make({
  services: () =>
    Layer.effectDiscard(Effect.fail(new Unreachable({ store: "services" }))),
  routes: Layer.empty,
}) {}

export class Counted extends ActionDurableObject.make({
  services: () => Builds.layer,
  routes: buildsRoutes.pipe(Layer.provide(slowUpstream)),
  alarm: () => buildsAlarm,
}) {
  async builds() {
    return await this.run(Effect.service(Builds));
  }

  async providedBuilds() {
    return await this.run(Effect.provide(Effect.service(Builds), Builds.layer));
  }
}

export class OwnSockets extends ActionDurableObject.make({
  services: () => startup,
  routes: ownSocketRoutes,
}) {
  override async webSocketMessage(
    socket: WebSocket,
    message: string | ArrayBuffer
  ) {
    if (!this.ctx.getTags(socket).includes(ownTag)) {
      await super.webSocketMessage(socket, message);

      return;
    }

    socket.send(message);
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

  override async fetch(request: Request) {
    return await this.#object.fetch(request);
  }

  override async alarm(info?: AlarmInvocationInfo) {
    await this.#object.alarm(info);
  }

  async builds() {
    return await this.#object.run(Effect.service(Builds));
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

export class Streamed extends ActionDurableObject.make({
  calls: streamCalls,
}) {}

export class Native extends ActionDurableObject.make({ calls: nativeCalls }) {}

export class Raced extends ActionDurableObject.make({ calls: racedCalls }) {
  async yieldsPastTimer() {
    return await this.run(yieldsPastTimer);
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

export class Unserved extends ActionDurableObject.make({
  calls: Layer.empty,
}) {}

export default { fetch: () => new Response(null, { status: 404 }) };

export class FromEnv extends ActionDurableObject.make({
  services: (env) => Layer.succeed(Greeting, env.GREETING),
}) {
  async greeting() {
    return await this.run(Effect.service(Greeting));
  }
}

export class Delegating extends DurableObject {
  readonly #object = ActionDurableObject.handlers(this.ctx, {
    services: PluginStore.layer,
    calls: pluginCalls,
  });

  async effectActionsRpc(request: ActionDurableObject.StubRequest) {
    return await this.#object.effectActionsRpc(request);
  }
}

export class Failing extends ActionDurableObject.make({
  alarm: () =>
    Effect.flatMap(ActionDurableObject.State, ({ storage }) =>
      Effect.promise(async () => {
        await storage.put(
          "runs",
          ((await storage.get<number>("runs")) ?? 0) + 1
        );
      })
    ).pipe(Effect.andThen(Effect.fail(new Unreachable({ store: "alarm" })))),
}) {
  async arm() {
    await this.run(
      Effect.flatMap(DateTime.now, (now) =>
        ActionDurableObject.Alarm.use(({ set }) => set(now))
      )
    );
  }

  async runs() {
    return await this.run(
      Effect.flatMap(ActionDurableObject.State, ({ storage }) =>
        Effect.promise(async () => (await storage.get<number>("runs")) ?? 0)
      )
    );
  }
}

export class Versioned extends ActionDurableObject.make({
  routes: versionedRoutes,
}) {}

export class Watching extends ActionDurableObject.make({
  routes: watchedRoutes,
}) {
  async note(text: string) {
    await this.run(note(text));
  }

  async say(text: string) {
    await this.run(say(text));
  }

  async status(text: string) {
    await this.run(setStatus(text));
  }

  async revoke(token: string) {
    await this.run(
      Effect.flatMap(ActionDurableObject.State, ({ storage }) =>
        Effect.promise(async () => {
          await storage.put(revokedKey(token), true);
        })
      )
    );
  }
}

export class Hooking extends ActionDurableObject.make({
  services: () => heldTime,
  routes: hookedRoutes,
}) {
  async hook(text: string) {
    await this.run(hook(text));
  }
}

export class Shelf extends ActionDurableObject.make({
  placed: shelves,
  routes: shelfRoutes,
  calls: shelfCalls,
}) {}

const stored = (key: string) =>
  Effect.flatMap(ActionDurableObject.State, ({ storage }) =>
    Effect.promise(async () => await storage.get<number | boolean>(key))
  );

const changed = ActionDurableObject.Tasks.use((tasks) =>
  tasks.runAfter(
    "tell",
    Effect.gen(function* () {
      const { storage } = yield* ActionDurableObject.State;
      const changes = Number((yield* stored("changes")) ?? 0);

      yield* Effect.promise(async () => {
        await storage.put("changes", changes + 1);
      });
    })
  )
);

export class Tasked extends ActionDurableObject.make({
  routes: HttpRouter.add(
    "POST",
    "/change",
    Effect.as(changed, HttpServerResponse.empty())
  ),
  tasks: {
    tell: Effect.gen(function* () {
      const { storage } = yield* ActionDurableObject.State;

      if ((yield* stored("down")) === true) {
        return yield* new Unreachable({ store: "listener" });
      }

      const changes = Number((yield* stored("changes")) ?? 0);

      yield* Effect.promise(async () => {
        await storage.put("told", changes);
      });
    }),
  },
}) {
  async change() {
    await this.run(changed);
  }

  async down(down: boolean) {
    await this.run(
      Effect.flatMap(ActionDurableObject.State, ({ storage }) =>
        Effect.promise(async () => {
          await storage.put("down", down);
        })
      )
    );
  }

  async told() {
    return await this.run(
      Effect.map(stored("told"), (told) => Number(told ?? 0))
    );
  }
}
