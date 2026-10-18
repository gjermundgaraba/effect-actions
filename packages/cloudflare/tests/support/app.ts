import { Context, Deferred, Effect, Layer, Redacted, Schema } from "effect";
import { HttpRouter } from "effect/http";
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

export const Hold = Action.make("hold", {
  description: "Answer once release is called on the same instance",
  readOnly: true,
  caller: Action.Anyone,
});

export const Release = Action.make("release", {
  description: "Answer every held call",
  readOnly: false,
  caller: Action.Anyone,
});

const actions = [Whoami, Spend, ReadNote, Schedule, Alarms, Hold, Release] as const;

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

export class Opened extends Context.Service<Opened, number>()("test/Opened") {
  static readonly layer = Layer.effect(Opened)(
    Effect.flatMap(Effect.service(ActionDurableObject.State), ({ storage }) =>
      Effect.promise(async () => {
        const opened = ((await storage.get<number>("opened")) ?? 0) + 1;

        await storage.put("opened", opened);

        return opened;
      }),
    ),
  );
}

export const implementation = Action.implement(
  actions,
  Effect.gen(function* () {
    const { storage } = yield* ActionDurableObject.State;
    const released = yield* Deferred.make<void>();
    let balance = 10;

    yield* Opened;

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
      hold: () => Deferred.await(released),
      release: () => Deferred.succeed(released, undefined),
    };
  }),
  { authorize: Action.allowAll },
);

export const startup = Layer.provideMerge(Action.layer(implementation), Opened.layer);

export const slowUpstream = Layer.effectDiscard(
  Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 20))),
);

const rpcRoutes = ActionRpc.layer(Rpc, implementation, { middleware: [ResolveNote] }).pipe(
  Layer.provide(resolveNote),
);

export const routes = Layer.mergeAll(
  ActionHttp.layer(Http, implementation),
  rpcRoutes.pipe(
    Layer.provide(RpcServer.layerProtocolHttp({ path: "/rpc" })),
    Layer.provide(RpcSerialization.layerJson),
  ),
).pipe(Layer.provide(authenticate), Layer.provide(startup));

export const socketRoutes = Layer.mergeAll(
  ActionHttp.layer(Http, implementation),
  rpcRoutes.pipe(
    Layer.provide(ActionDurableObject.layerWebSocket(Rpc, { path: "/rpc", headers: [noteHeader] })),
  ),
).pipe(Layer.provide(authenticate), Layer.provide(startup), Layer.provide(slowUpstream));

export const routerProvidedRoutes = ActionRpc.layer(Rpc, implementation).pipe(
  Layer.provide(ActionDurableObject.layerWebSocket(Rpc, { path: "/rpc" })),
  HttpRouter.provideRequest(Layer.succeed(CurrentNote, "router")),
  Layer.provide(authenticate),
  Layer.provide(startup),
);

export const alarm = Effect.gen(function* () {
  const { storage } = yield* ActionDurableObject.State;
  const client = yield* Action.client(implementation);

  yield* client.spend({ amount: 1 }).pipe(Effect.provideService(CurrentUser, "alarm"));

  const ran = (yield* Effect.promise(() => storage.get<number>(alarmsKey))) ?? 0;

  yield* Effect.promise(() => storage.put(alarmsKey, ran + 1));
}).pipe(Effect.provide(startup));
