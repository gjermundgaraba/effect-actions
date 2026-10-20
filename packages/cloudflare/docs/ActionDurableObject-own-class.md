# ActionDurableObject in a class of your own

Serve actions from a Durable Object class you write yourself, with its own methods, its own
sockets or its own runtime, through the primitives `make` is built from. Read
[ActionDurableObject.md](ActionDurableObject.md) first: its API, sockets, alarm and limits hold
here too. When something fails, search
[ActionDurableObject-failures.md](ActionDurableObject-failures.md).

## Delegate to handlers

`handlers(this.ctx, options)` takes `make`'s options and returns the object's handlers, each
taking the runtime's own arguments. Delegate the ones it should serve and write the others.

```ts
export class PluginHost extends DurableObject<Env> {
  readonly #object = ActionDurableObject.handlers(this.ctx, {
    services,
    calls: RpcServer.layer(PluginRpcs).pipe(Layer.provide(pluginHandlers)),
    alarm: () => plugin.alarm,
  });

  override fetch(request: Request) {
    return this.#object.run(plugin.forward(request));
  }

  override alarm() {
    return this.#object.alarm();
  }

  effectActionsRpc(...request: Parameters<ActionDurableObject.Handlers["effectActionsRpc"]>) {
    return this.#object.effectActionsRpc(...request);
  }
}
```

- `fetch`, `webSocketMessage`, `webSocketClose`, `webSocketError`, `effectActionsRpc`,
  `alarm` and `run` each await the object's build, which the first of them starts: the
  services, with `State` provided, then `calls`, with `Calls` and `layerStub()`, and `routes`,
  with `Sockets`. Every handler and `run` shares it.
- A build that fails rejects the events awaiting it and is dropped with everything it built; the
  next event builds again from nothing. Nothing holds the object while it builds, so a build
  has no time limit of its own.
- Without `routes`, `fetch` answers 404, and the socket handlers resolve at once, building
  nothing. Without `calls`, `effectActionsRpc` rejects at once.
- `effectActionsRpc` is the method `layerStubClient` and `client` call: a class serving
  `calls` defines it, delegating, its parameters `Handlers`', and a stub of a class without it
  is refused by their types.
  Methods of the class's own, running Effects with `run`, stay callable beside it.
- Without `alarm`, `handlers`' `alarm` runs nothing, once the object is built. Define the class's `alarm` only when it has
  one: workerd refuses `storage.setAlarm` on a class without an `alarm` method.
- The socket handlers dispatch through `Sockets` and resolve for a socket no protocol accepted.
  To answer sockets of your own, accept them with a tag, and in `webSocketMessage` answer those
  carrying it and delegate the rest.
- `run(effect)` gives the effect the services, `State` and a `Scope`, closed when it ends. A
  Layer it provides itself is built for that call alone: what calls share belongs in
  `services`.

## Compose the primitives yourself

An application with its own `ManagedRuntime` serves rpcs over hibernating sockets with
`Sockets.layer` among its services and `layerWebSocket` in its routes, dispatching its socket
events through `Sockets`, and rpcs over its stub with its calls in the runtime, over
`layerStub()` and `Calls.layer`, dispatching each call through `Calls`.

```ts
export class Room extends DurableObject {
  readonly #memoMap = Layer.makeMemoMapUnsafe();
  readonly #services = Layer.mergeAll(
    services,
    ActionDurableObject.Sockets.layer,
    calls.pipe(
      Layer.provide(ActionDurableObject.layerStub()),
      Layer.provideMerge(ActionDurableObject.Calls.layer),
    ),
  ).pipe(Layer.provideMerge(Layer.succeed(ActionDurableObject.State, this.ctx)));
  readonly #runtime = ManagedRuntime.make(this.#services, { memoMap: this.#memoMap });
  readonly #routesBuilt = Deferred.makeUnsafe<void, unknown>();
  readonly #web = HttpRouter.toWebHandler(
    routes.pipe(
      Layer.tap(() => Deferred.succeed(this.#routesBuilt, undefined)),
      Layer.tapCause((cause) => Deferred.failCause(this.#routesBuilt, cause)),
      Layer.provide([this.#services, HttpServer.layerServices]),
    ),
    { memoMap: this.#memoMap },
  );

  override fetch(request: Request) {
    return this.#web.handler(request);
  }

  override async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer) {
    const taken = await this.#runtime.runPromise(
      Effect.andThen(
        Deferred.await(this.#routesBuilt),
        ActionDurableObject.Sockets.use((sockets) => sockets.message(socket, message)),
      ),
    );

    if (!taken) answerOwn(socket, message);
  }

  // webSocketClose and webSocketError likewise, with `sockets.close` and `sockets.error`.

  effectActionsRpc(...[request]: Parameters<ActionDurableObject.Handlers["effectActionsRpc"]>) {
    return this.#runtime.runPromise(ActionDurableObject.Calls.use((calls) => calls.call(request)));
  }
}
```

- **One memo map** for the runtime and `toWebHandler`: `Sockets.layer` is then built once per
  instance, and the routes' protocols register with the `Sockets` the runtime dispatches
  through. With two, each builds its own, and no message is answered.
- **Dispatch once the routes are built.** A protocol registers with `Sockets` as the routes
  build, and a socket's message is often a woken instance's first event, which the runtime
  delivers before the routes are built: dispatched then, `Sockets` finds no protocol and
  answers `false`.
- `Sockets` answers `false` for a socket no protocol accepted: answer it, or ignore it.
- **The calls build with the runtime**, so `layerStub()` has registered with `Calls` before the
  first call is dispatched: unlike sockets, nothing waits on the routes. `Calls.layer` belongs
  in the runtime's Layer once, merged out of the calls, so the protocol registers with the
  `Calls` the method dispatches through.
- A failed build stays failed: `ManagedRuntime` keeps its build's failure, and `toWebHandler`
  rejects every request with it, until the runtime evicts the instance. `handlers` builds
  again on the next event instead.
