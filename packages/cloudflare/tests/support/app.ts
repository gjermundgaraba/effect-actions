import { Context, Data, Effect, Layer, Redacted, Schema } from "effect";
import { HttpRouter, HttpServerResponse } from "effect/http";
import { RpcMiddleware, RpcSerialization, RpcServer } from "effect/rpc";
import * as Action from "@gjermundgaraba/effect-actions/Action";
import * as ActionHttp from "@gjermundgaraba/effect-actions/ActionHttp";
import * as ActionRpc from "@gjermundgaraba/effect-actions/ActionRpc";
import * as Authentication from "@gjermundgaraba/effect-actions/Authentication";
import * as ActionDurableObject from "../../src/durable/ActionDurableObject.js";

export class CurrentUser extends Context.Service<CurrentUser, string>()("test/CurrentUser") {}

export const Login = Authentication.make("test.Login", CurrentUser);

export class Overdrawn extends Schema.TaggedError<Overdrawn>()(
  "Overdrawn",
  { by: Schema.Int },
  { httpApiStatus: 409 },
) {}

export const noteHeader = "x-note";

export class CurrentNote extends Context.Service<CurrentNote, string>()("test/CurrentNote") {}

export class ResolveNote extends RpcMiddleware.Service<ResolveNote, { provides: CurrentNote }>()(
  "test/ResolveNote",
) {}

const resolveNote = Layer.succeed(ResolveNote, (call, { headers }) =>
  Effect.provideService(call, CurrentNote, headers[noteHeader] ?? "none"),
);

export const Whoami = Action.make("whoami", {
  description: "The signed-in user",
  readOnly: true,
  caller: CurrentUser,
  success: Schema.String,
});

export const Spend = Action.make("spend", {
  description: "Spend from the instance's balance of 10",
  readOnly: false,
  caller: CurrentUser,
  input: { amount: Schema.Int },
  success: { left: Schema.Int },
  error: Overdrawn,
});

export const ReadNote = Action.make("readNote", {
  description: "The note the call's headers carry",
  readOnly: true,
  caller: Action.Anyone,
  success: Schema.String,
});

export const Schedule = Action.make("schedule", {
  description: "Set the object's alarm",
  readOnly: false,
  caller: Action.Anyone,
});

export const Alarms = Action.make("alarms", {
  description: "How many alarms ran on the object",
  readOnly: true,
  caller: Action.Anyone,
  success: Schema.Int,
});

export const Pause = Action.make("pause", {
  description: "Answer after a tenth of a second",
  readOnly: true,
  caller: Action.Anyone,
});

const actions = [Whoami, Spend, ReadNote, Schedule, Alarms, Pause] as const;

export const Http = ActionHttp.make([Whoami, Spend, Schedule, Alarms], { authentication: Login });

export const Rpc = ActionRpc.make(actions, { authentication: Login });

const users = ["ada", "grace"] as const;

const isUser = (name: string): name is (typeof users)[number] =>
  users.some((user) => user === name);

export const authenticate = Authentication.layer(Login, (token: Redacted.Redacted<string>) =>
  isUser(Redacted.value(token))
    ? Effect.succeed(Redacted.value(token))
    : Effect.fail(new Action.Unauthenticated({ message: "Unknown test token." })),
);

const alarmsKey = "alarms";

export class StartupRead extends Context.Service<StartupRead, void>()("test/StartupRead") {
  static readonly layer = Layer.effect(StartupRead)(
    Effect.flatMap(Effect.service(ActionDurableObject.State), ({ storage }) =>
      Effect.asVoid(Effect.promise(() => storage.get("startup"))),
    ),
  );
}

export const implementation = Action.implement(
  actions,
  Effect.gen(function* () {
    const { storage } = yield* ActionDurableObject.State;
    let balance = 10;

    yield* StartupRead;

    return {
      whoami: () => Effect.service(CurrentUser),
      spend: ({ amount }) =>
        amount > balance
          ? Effect.fail(new Overdrawn({ by: amount - balance }))
          : Effect.sync(() => ({ left: (balance -= amount) })),
      readNote: () => Effect.service(CurrentNote),
      schedule: () => Effect.promise(() => storage.setAlarm(Date.now() + 60_000)),
      alarms: () =>
        Effect.promise(() => storage.get<number>(alarmsKey)).pipe(Effect.map((n) => n ?? 0)),
      pause: () =>
        Effect.promise(() => storage.put("pauseStarted", true)).pipe(
          Effect.andThen(Effect.sleep("100 millis")),
          Effect.onInterrupt(() => Effect.promise(() => storage.put("pauseInterrupted", true))),
        ),
    };
  }),
  { authorize: Action.allowAll },
);

export class Actions extends Context.Service<Actions, Action.Client<typeof implementation>>()(
  "test/Actions",
) {
  static readonly layer = Layer.effect(Actions)(Action.client(implementation));
}

export const startup = Layer.mergeAll(Action.layer(implementation), Actions.layer).pipe(
  Layer.provideMerge(StartupRead.layer),
);

export const slowUpstream = Layer.effectDiscard(
  Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 20))),
);

const rpcRoutes = ActionRpc.layer(Rpc, implementation, { middleware: [ResolveNote] }).pipe(
  Layer.provide(resolveNote),
);

export const stubCalls = rpcRoutes.pipe(Layer.provide(authenticate));

export const routes = Layer.mergeAll(
  ActionHttp.layer(Http, implementation),
  rpcRoutes.pipe(
    Layer.provide(RpcServer.layerProtocolHttp({ path: "/rpc" })),
    Layer.provide(RpcSerialization.layerJson),
  ),
).pipe(Layer.provide(authenticate), Layer.provide(startup));

export class Greeting extends Context.Service<Greeting, string>()("test/Greeting") {}

const greetingRoute = HttpRouter.add(
  "GET",
  "/greeting",
  Effect.map(Effect.service(Greeting), (greeting) => HttpServerResponse.text(greeting)),
).pipe(Layer.provideMerge(Layer.succeed(Greeting, "hello")));

export const socketRoutes = Layer.mergeAll(
  ActionHttp.layer(Http, implementation),
  rpcRoutes.pipe(Layer.provide(ActionDurableObject.layerWebSocket({ path: "/rpc" }))),
  greetingRoute,
).pipe(Layer.provide(authenticate), Layer.provide(slowUpstream));

export const routerProvidedRoutes = ActionRpc.layer(Rpc, implementation).pipe(
  Layer.provide(ActionDurableObject.layerWebSocket({ path: "/rpc" })),
  HttpRouter.provideRequest(Layer.succeed(CurrentNote, "router")),
  Layer.provide(authenticate),
  Layer.provide(startup),
);

const mountedAt = (prefix: string) =>
  ActionRpc.layer(Rpc, implementation, { middleware: [ResolveNote] }).pipe(
    Layer.provide(ActionDurableObject.layerWebSocket({ path: "/rpc" })),
    Layer.updateService(HttpRouter.HttpRouter, (router) => router.prefixed(prefix)),
  );

export const prefixedRoutes = Layer.mergeAll(mountedAt("/a"), mountedAt("/b")).pipe(
  Layer.provide(resolveNote),
  Layer.provide(authenticate),
  Layer.provide(startup),
);

export const alarm = Effect.gen(function* () {
  const { storage } = yield* ActionDurableObject.State;
  const client = yield* Actions;

  yield* client.spend({ amount: 1 }).pipe(Effect.provideService(CurrentUser, "alarm"));

  const ran = (yield* Effect.promise(() => storage.get<number>(alarmsKey))) ?? 0;

  yield* Effect.promise(() => storage.put(alarmsKey, ran + 1));
});

const buildsKey = "builds";

export const alarmBuildsKey = "alarmBuilds";

export class Builds extends Context.Service<Builds, number>()("test/Builds") {
  static readonly layer = Layer.effect(Builds)(
    Effect.gen(function* () {
      const { storage } = yield* ActionDurableObject.State;
      const builds = ((yield* Effect.promise(() => storage.get<number>(buildsKey))) ?? 0) + 1;

      yield* Effect.promise(() => storage.put(buildsKey, builds));

      return builds;
    }),
  );
}

export const buildsRoutes = HttpRouter.add(
  "GET",
  "/builds",
  Effect.map(Effect.service(Builds), (builds) => HttpServerResponse.text(String(builds))),
);

export const buildsAlarm = Effect.gen(function* () {
  const { storage } = yield* ActionDurableObject.State;
  const builds = yield* Builds;

  yield* Effect.promise(() => storage.put(alarmBuildsKey, builds));
});

export const ownTag = "own";

const ownSocketRoute = HttpRouter.use((router) =>
  Effect.gen(function* () {
    const state = yield* ActionDurableObject.State;

    yield* router.add(
      "GET",
      "/own",
      Effect.sync(() => {
        const { 0: client, 1: server } = new WebSocketPair();

        state.acceptWebSocket(server, [ownTag]);

        return HttpServerResponse.raw(new Response(null, { status: 101, webSocket: client }), {
          status: 101,
        });
      }),
    );
  }),
);

export const ownSocketRoutes = Layer.mergeAll(socketRoutes, ownSocketRoute);

export const readyKey = "ready";

export class NotReady extends Data.TaggedError("NotReady")<{ readonly key: string }> {}

const readyOnceSet = Layer.effectDiscard(
  Effect.gen(function* () {
    const { storage } = yield* ActionDurableObject.State;

    if ((yield* Effect.promise(() => storage.get(readyKey))) !== true) {
      return yield* new NotReady({ key: readyKey });
    }
  }),
);

export const retriedRoutes = Layer.mergeAll(buildsRoutes, readyOnceSet).pipe(
  Layer.provide(
    rpcRoutes.pipe(
      Layer.provide(ActionDurableObject.layerWebSocket({ path: "/rpc" })),
      Layer.provide(authenticate),
    ),
  ),
);

export const readyAtOnce = Layer.effectDiscard(
  Effect.flatMap(Effect.service(ActionDurableObject.State), ({ storage }) =>
    storage.kv.get(readyKey) === true ? Effect.void : Effect.fail(new NotReady({ key: readyKey })),
  ),
);

export const readyRoute = HttpRouter.add(
  "GET",
  "/ready",
  Effect.succeed(HttpServerResponse.text("ready")),
);
