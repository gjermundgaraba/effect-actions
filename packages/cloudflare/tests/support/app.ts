import { Context, Effect, Layer, Redacted, Schema } from "effect";
import { RpcSerialization, RpcServer } from "effect/rpc";
import * as Action from "@gjermundgaraba/effect-actions/Action";
import * as ActionHttp from "@gjermundgaraba/effect-actions/ActionHttp";
import * as ActionRpc from "@gjermundgaraba/effect-actions/ActionRpc";
import * as Authentication from "@gjermundgaraba/effect-actions/Authentication";

export class CurrentUser extends Context.Service<CurrentUser, string>()("test/CurrentUser") {}

export const Login = Authentication.make("test.Login", CurrentUser);

export class Overdrawn extends Schema.TaggedError<Overdrawn>()(
  "Overdrawn",
  { by: Schema.Int },
  { httpApiStatus: 409 },
) {}

export const Whoami = Action.make("whoami", {
  description: "The signed-in user",
  readOnly: true,
  caller: CurrentUser,
  success: Schema.String,
});

export const Spend = Action.make("spend", {
  description: "Spend from the object's balance of 10",
  readOnly: false,
  caller: CurrentUser,
  input: { amount: Schema.Int },
  success: { left: Schema.Int },
  error: Overdrawn,
});

export const Http = ActionHttp.make([Whoami, Spend], { authentication: Login });

export const Rpc = ActionRpc.make([Whoami, Spend], { authentication: Login });

export const users = ["ada", "grace"] as const;

const isUser = (name: string): name is (typeof users)[number] =>
  users.some((user) => user === name);

export const authenticate = Authentication.layer(Login, (token: Redacted.Redacted<string>) =>
  isUser(Redacted.value(token))
    ? Effect.succeed(Redacted.value(token))
    : Effect.fail(new Action.Unauthenticated({ message: "Unknown test token." })),
);

const implementation = Action.implement(
  [Whoami, Spend],
  Effect.sync(() => {
    let balance = 10;

    return {
      whoami: () => Effect.service(CurrentUser),
      spend: ({ amount }) =>
        amount > balance
          ? Effect.fail(new Overdrawn({ by: amount - balance }))
          : Effect.sync(() => ({ left: (balance -= amount) })),
    };
  }),
  { authorize: Action.allowAll },
);

export const routes = Layer.mergeAll(
  ActionHttp.layer(Http, implementation),
  ActionRpc.layer(Rpc, implementation).pipe(
    Layer.provide(RpcServer.layerProtocolHttp({ path: "/rpc" })),
    Layer.provide(RpcSerialization.layerJson),
  ),
).pipe(Layer.provide(authenticate));
