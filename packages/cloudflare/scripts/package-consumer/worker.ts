import { DurableObject } from "cloudflare:workers";
import { Effect, Layer, ManagedRuntime, Schema, type Scope } from "effect";
import { HttpRouter, type HttpClient } from "effect/http";
import { Rpc as NativeRpc, RpcClient, RpcGroup, RpcServer } from "effect/rpc";
import * as Action from "@gjermundgaraba/effect-actions/Action";
import * as ActionHttp from "@gjermundgaraba/effect-actions/ActionHttp";
import * as ActionRpc from "@gjermundgaraba/effect-actions/ActionRpc";
import * as ActionDurableObject from "@gjermundgaraba/effect-actions-cloudflare/ActionDurableObject";

export const Ping = Action.make("ping", {
  description: "Answer pong",
  readOnly: true,
  caller: Action.Anyone,
  success: Schema.Literal("pong"),
});

export const Http = ActionHttp.make([Ping]);

export const toObject = (stub: DurableObjectStub): Layer.Layer<HttpClient.HttpClient> =>
  ActionDurableObject.layerHttpClient(stub);

export const checkLayerTypes = (stub: DurableObjectStub) => {
  // @ts-expect-error -- Published declarations must type what the layer provides.
  const wrong: Layer.Layer<number> = ActionDurableObject.layerHttpClient(stub);

  // @ts-expect-error -- Published declarations must take only something that fetches.
  ActionDurableObject.layerHttpClient({});

  return wrong;
};

export const ping = (stub: DurableObjectStub): Effect.Effect<"pong", unknown> =>
  ActionHttp.client(Http, { baseUrl: "https://object" }).pipe(
    Effect.flatMap((client) => client.ping()),
    Effect.provide(toObject(stub)),
  );

export const Rpc = ActionRpc.make([Ping]);

const pong = Action.implement(Ping, () => Effect.succeed("pong" as const));

const socket = ActionRpc.layer(Rpc, pong).pipe(
  Layer.provide(ActionDurableObject.layerWebSocket({ path: "/rpc" })),
);

export class Room extends ActionDurableObject.make({
  routes: socket,
  alarm: (info) =>
    Effect.asVoid(Effect.service(ActionDurableObject.State)).pipe(
      Effect.when(Effect.succeed((info?.retryCount ?? 0) < 3)),
    ),
}) {}

export const checkMakeTypes = () =>
  ActionDurableObject.make({
    // @ts-expect-error -- Published declarations must refuse routes lacking a startup service, here the protocol.
    routes: ActionRpc.layer(Rpc, pong),
  });

export class Hosted extends DurableObject {
  readonly #object = ActionDurableObject.handlers(this.ctx, { routes: socket });

  override fetch(request: Request) {
    return this.#object.fetch(request);
  }

  override webSocketMessage(socket: WebSocket, message: string | ArrayBuffer) {
    return this.#object.webSocketMessage(socket, message);
  }

  ping(): Promise<"pong"> {
    return this.#object.run(Effect.succeed("pong" as const));
  }
}

export const dispatch = (
  socket: WebSocket,
  message: string,
): Effect.Effect<boolean, never, ActionDurableObject.Sockets> =>
  ActionDurableObject.Sockets.use((sockets) => sockets.message(socket, message));

export const sockets: Layer.Layer<ActionDurableObject.Sockets, never, ActionDurableObject.State> =
  ActionDurableObject.Sockets.layer;

export const checkSocketsTypes = (ctx: DurableObjectState) =>
  Effect.runPromise(
    // @ts-expect-error -- Published declarations must require the Sockets a protocol registers with.
    Layer.build(
      ActionDurableObject.layerWebSocket({ path: "/rpc" }).pipe(
        Layer.provide([Layer.succeed(ActionDurableObject.State, ctx), HttpRouter.layer]),
      ),
    ).pipe(Effect.scoped),
  );

export class NotFound extends Schema.TaggedError<NotFound>()("NotFound", { id: Schema.String }) {}

export const Hosts = RpcGroup.make(
  NativeRpc.make("start", {
    payload: { id: Schema.String },
    success: Schema.String,
    error: NotFound,
  }),
);

const hostCalls = RpcServer.layer(Hosts).pipe(
  Layer.provide(
    Hosts.toLayer({
      start: ({ id }) => (id === "" ? Effect.fail(new NotFound({ id })) : Effect.succeed(id)),
    }),
  ),
);

export class Host extends ActionDurableObject.make({ calls: hostCalls }) {}

export const checkCallsTypes = () =>
  ActionDurableObject.make({
    // @ts-expect-error -- Published declarations must refuse calls whose handlers no Layer provides.
    calls: RpcServer.layer(Hosts),
  });

export const toHost = (stub: DurableObjectStub<Host>): Layer.Layer<RpcClient.Protocol> =>
  ActionDurableObject.layerStubClient(stub);

export const checkStubTypes = (stub: DurableObjectStub<Hosted>) =>
  // @ts-expect-error -- Published declarations must refuse a stub of a class without the method.
  ActionDurableObject.layerStubClient(stub);

export const start = (
  stub: DurableObjectStub<Host>,
  id: string,
): Effect.Effect<string, NotFound, Scope.Scope> =>
  Effect.flatMap(ActionDurableObject.client(Hosts), (host) => host(stub).start({ id }));

export const startRaw = (stub: DurableObjectStub<Host>) =>
  RpcClient.make(Hosts).pipe(
    Effect.flatMap((client) => client.start({ id: "a" })),
    Effect.provide(toHost(stub)),
  );

export const checkRawTypes = (stub: DurableObjectStub<Host>) => {
  // @ts-expect-error -- Published declarations must keep RpcClientError in the raw client's errors.
  const typed: Effect.Effect<string, NotFound, Scope.Scope> = startRaw(stub);

  return typed;
};

export class Composed extends DurableObject {
  readonly #runtime = ManagedRuntime.make(
    hostCalls.pipe(
      Layer.provide(ActionDurableObject.layerStub()),
      Layer.provideMerge(ActionDurableObject.Calls.layer),
    ),
  );

  effectActionsRpc(
    ...[request]: Parameters<ActionDurableObject.Handlers["effectActionsRpc"]>
  ): ReturnType<ActionDurableObject.Handlers["effectActionsRpc"]> {
    return this.#runtime.runPromise(ActionDurableObject.Calls.use((calls) => calls.call(request)));
  }
}

export const toComposed = (stub: DurableObjectStub<Composed>) =>
  ActionDurableObject.layerStubClient(stub);
