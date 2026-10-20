import type { DurableObject } from "cloudflare:workers";
import { Context, Effect, Layer, type Scope } from "effect";
import { HttpRouter, HttpServerResponse } from "effect/http";
import { RpcClient, type RpcClientError, type RpcMessage, RpcServer } from "effect/rpc";
import { expectTypeOf } from "@effect/vitest";
import * as ActionHttp from "@gjermundgaraba/effect-actions/ActionHttp";
import * as ActionRpc from "@gjermundgaraba/effect-actions/ActionRpc";
import * as ActionDurableObject from "../../src/durable/ActionDurableObject.js";
import {
  Builds,
  buildsRoutes,
  CurrentUser,
  Greeting,
  Http,
  implementation,
  Rpc,
  routerProvidedRoutes,
  socketRoutes,
  startup,
  stubCalls,
} from "../support/app.js";
import {
  pluginCalls,
  PluginHasNoPane,
  PluginNotFound,
  PluginRpcs,
  PluginStore,
  StreamRpcs,
} from "../support/hosts.js";
import type { Hosted, Manual, Plain, PluginHost } from "../worker.js";

expectTypeOf(ActionDurableObject.make({ routes: routerProvidedRoutes })).toEqualTypeOf<
  new (ctx: DurableObjectState, env: Cloudflare.Env) => ActionDurableObject.Instance
>();

expectTypeOf<ActionDurableObject.Instance>().toExtend<DurableObject<Cloudflare.Env>>();

expectTypeOf(ActionDurableObject.layerWebSocket({ path: "/rpc" })).toEqualTypeOf<
  Layer.Layer<
    RpcServer.Protocol,
    never,
    ActionDurableObject.Sockets | ActionDurableObject.State | HttpRouter.HttpRouter
  >
>();

declare const ctx: DurableObjectState;

void Effect.runPromise(
  // @ts-expect-error -- A protocol registers with the instance's Sockets, which nothing here provides.
  Layer.build(
    ActionDurableObject.layerWebSocket({ path: "/rpc" }).pipe(
      Layer.provide([Layer.succeed(ActionDurableObject.State, ctx), HttpRouter.layer]),
    ),
  ).pipe(Effect.scoped),
);

expectTypeOf(ActionDurableObject.Sockets.layer).toEqualTypeOf<
  Layer.Layer<ActionDurableObject.Sockets, never, ActionDurableObject.State>
>();

expectTypeOf<ReturnType<ActionDurableObject.Sockets["Service"]["message"]>>().toEqualTypeOf<
  Effect.Effect<boolean>
>();

expectTypeOf(ActionDurableObject.handlers(ctx, { services: Builds.layer })).toEqualTypeOf<
  ActionDurableObject.Handlers<Builds>
>();

expectTypeOf(
  ActionDurableObject.handlers(ctx, { services: startup, routes: socketRoutes }),
).toEqualTypeOf<ActionDurableObject.Handlers<Layer.Success<typeof startup>>>();

expectTypeOf<Parameters<ActionDurableObject.Handlers["webSocketClose"]>>().toEqualTypeOf<
  Parameters<NonNullable<DurableObject<Cloudflare.Env>["webSocketClose"]>>
>();

expectTypeOf<Parameters<ActionDurableObject.Handlers["alarm"]>>().toEqualTypeOf<
  Parameters<NonNullable<DurableObject<Cloudflare.Env>["alarm"]>>
>();

declare const hosted: ActionDurableObject.Handlers<Builds>;

expectTypeOf(hosted.run(Effect.service(Builds))).toEqualTypeOf<Promise<number>>();

// @ts-expect-error -- A run has only the services the object was given.
void hosted.run(Effect.service(CurrentUser));

ActionDurableObject.handlers(ctx, {
  // @ts-expect-error -- The routes require startup services no Layer provides.
  routes: socketRoutes,
});

ActionDurableObject.handlers(ctx, {
  services: Builds.layer,
  // @ts-expect-error -- The alarm has no caller unless it names one itself.
  alarm: () => Effect.asVoid(Effect.service(CurrentUser)),
});

ActionDurableObject.make({
  services: startup,
  routes: socketRoutes,
  alarm: () => Effect.asVoid(Effect.all([Effect.service(ActionDurableObject.State), Effect.scope])),
});

class Merged extends Context.Service<Merged, number>()("test/Merged") {}

ActionDurableObject.make({
  routes: HttpRouter.add(
    "GET",
    "/merged",
    Effect.as(Effect.service(Merged), HttpServerResponse.empty()),
  ).pipe(Layer.provideMerge(Layer.succeed(Merged, 1))),
});

export class WithCloseCode extends ActionDurableObject.make({
  services: startup,
  routes: socketRoutes,
}) {
  override webSocketClose(socket: WebSocket, code: number, reason: string, wasClean: boolean) {
    return super.webSocketClose(socket, code, reason, wasClean);
  }
}

expectTypeOf<Parameters<ActionDurableObject.Instance["webSocketError"]>>().toEqualTypeOf<
  Parameters<NonNullable<DurableObject<Cloudflare.Env>["webSocketError"]>>
>();

ActionDurableObject.make({
  // @ts-expect-error -- A startup service other than State, here the descriptor's provider, is the routes' to provide.
  routes: ActionHttp.layer(Http, implementation),
});

ActionDurableObject.make({
  // @ts-expect-error -- A request-time service is provided per request by middleware or authentication, never by the object.
  routes: HttpRouter.add(
    "GET",
    "/caller",
    Effect.as(Effect.service(CurrentUser), HttpServerResponse.empty()),
  ),
});

ActionDurableObject.make({
  services: startup,
  routes: socketRoutes,
  // @ts-expect-error -- The alarm has no caller unless it names one itself.
  alarm: () => Effect.asVoid(Effect.service(CurrentUser)),
});

declare const instance: ActionDurableObject.Instance;

expectTypeOf(
  instance.run(Effect.as(Effect.all([Effect.service(ActionDurableObject.State), Effect.scope]), 1)),
).toEqualTypeOf<Promise<number>>();

// @ts-expect-error -- A run has no caller unless it names one itself.
void instance.run(Effect.service(CurrentUser));

ActionDurableObject.make({
  // @ts-expect-error -- The routes require startup services no Layer provides.
  routes: socketRoutes,
});

ActionDurableObject.make({
  // @ts-expect-error -- The services are built at startup, where no request has a caller.
  services: Layer.effect(Builds)(Effect.as(Effect.service(CurrentUser), 1)),
  routes: Layer.empty,
});

const WithServices = ActionDurableObject.make({ services: Builds.layer, routes: buildsRoutes });

declare const withServices: InstanceType<typeof WithServices>;

expectTypeOf(withServices.run(Effect.service(Builds))).toEqualTypeOf<Promise<number>>();

// @ts-expect-error -- A run has only the services the object was given.
void withServices.run(Effect.service(CurrentUser));

ActionDurableObject.make({
  services: Builds.layer,
  routes: buildsRoutes,
  alarm: () => Effect.asVoid(Effect.service(Builds)),
});

const FromEnv = ActionDurableObject.make({
  services: (env) => Layer.merge(Builds.layer, Layer.succeed(Greeting, env.GREETING)),
  routes: buildsRoutes,
});

declare const fromEnv: InstanceType<typeof FromEnv>;

expectTypeOf(fromEnv.run(Effect.service(Greeting))).toEqualTypeOf<Promise<string>>();

ActionDurableObject.make({
  // @ts-expect-error -- The services a function of env returns are built at startup too.
  services: () => Layer.effect(Builds)(Effect.as(Effect.service(CurrentUser), 1)),
  routes: Layer.empty,
});

expectTypeOf<Parameters<ActionDurableObject.Handlers["effectActionsRpc"]>>().toEqualTypeOf<
  [request: ActionDurableObject.StubRequest]
>();

expectTypeOf<ActionDurableObject.StubRequest>().toEqualTypeOf<
  ReadonlyArray<RpcMessage.FromClientEncoded>
>();

declare const pluginStub: DurableObjectStub<PluginHost>;

declare const plainStub: DurableObjectStub<Plain>;

declare const hostedStub: DurableObjectStub<Hosted>;

declare const manualStub: DurableObjectStub<Manual>;

expectTypeOf(ActionDurableObject.layerStubClient(pluginStub)).toEqualTypeOf<
  Layer.Layer<RpcClient.Protocol>
>();

ActionDurableObject.layerStubClient(manualStub);

// @ts-expect-error -- A stub of a class without the method has nothing to call.
ActionDurableObject.layerStubClient(plainStub);

// @ts-expect-error -- A class delegating to handlers serves calls only if it defines the method.
ActionDurableObject.layerStubClient(hostedStub);

const plugins = ActionDurableObject.client(PluginRpcs);

expectTypeOf(plugins).toEqualTypeOf<
  Effect.Effect<
    (stubOf: () => ActionDurableObject.Stub) => ActionDurableObject.Client<typeof PluginRpcs>,
    never,
    Scope.Scope
  >
>();

void Effect.map(plugins, (plugin) => plugin(() => pluginStub));

// @ts-expect-error -- A client calls an object through a stub of a class serving calls alone.
void Effect.map(plugins, (plugin) => plugin(() => plainStub));

// @ts-expect-error -- A client takes a factory of stubs, never a stub it would hold.
void Effect.map(plugins, (plugin) => plugin(pluginStub));

declare const plugin: ActionDurableObject.Client<typeof PluginRpcs>;

expectTypeOf(plugin.start()).toEqualTypeOf<
  Effect.Effect<{ readonly pane: string }, PluginNotFound | PluginHasNoPane>
>();

const raw = RpcClient.make(PluginRpcs).pipe(
  Effect.provide(ActionDurableObject.layerStubClient(pluginStub)),
);

expectTypeOf<Effect.Error<ReturnType<Effect.Success<typeof raw>["start"]>>>().toEqualTypeOf<
  PluginNotFound | PluginHasNoPane | RpcClientError.RpcClientError
>();

declare const streams: ActionDurableObject.Client<typeof StreamRpcs>;

expectTypeOf(streams.head()).toEqualTypeOf<Effect.Effect<string>>();

// @ts-expect-error -- An rpc that streams has no method over the stub, which answers once.
void streams.tail;

ActionDurableObject.make({ services: PluginStore.layer, calls: pluginCalls });

ActionDurableObject.make({ services: startup, calls: stubCalls });

ActionDurableObject.make({
  // @ts-expect-error -- The group's handlers are the calls' to provide.
  calls: RpcServer.layer(PluginRpcs),
});

ActionDurableObject.make({
  // @ts-expect-error -- A startup service other than State belongs in the services.
  calls: pluginCalls,
});

ActionDurableObject.make({
  services: startup,
  // @ts-expect-error -- A protected contract's authentication is the calls' to provide.
  calls: ActionRpc.layer(Rpc, implementation),
});

ActionDurableObject.make({
  services: PluginStore.layer,
  // @ts-expect-error -- The object provides its calls' one stub protocol: a second would collide with it.
  calls: pluginCalls.pipe(Layer.provide(ActionDurableObject.layerStub())),
});

ActionDurableObject.make({
  services: PluginStore.layer,
  // @ts-expect-error -- The stub's protocol serves calls, never routes, which no Calls reaches.
  routes: pluginCalls.pipe(Layer.provide(ActionDurableObject.layerStub())),
});

expectTypeOf(ActionDurableObject.layerStub()).toEqualTypeOf<
  Layer.Layer<RpcServer.Protocol, never, ActionDurableObject.Calls>
>();

expectTypeOf(ActionDurableObject.Calls.layer).toEqualTypeOf<
  Layer.Layer<ActionDurableObject.Calls>
>();
