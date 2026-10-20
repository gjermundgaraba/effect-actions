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
export class PluginHost extends DurableObject<Env> implements PluginHostRpc {
  readonly #object = ActionDurableObject.handlers(this.ctx, {
    services,
    alarm: () => plugin.alarm,
  });

  override fetch(request: Request) {
    return this.#object.run(plugin.forward(request));
  }

  override alarm() {
    return this.#object.alarm();
  }

  install(code: Code) {
    return this.#object.run(plugin.install(code));
  }
}
```

- `fetch`, `webSocketMessage`, `webSocketClose`, `webSocketError`, `alarm` and `run` each await
  the object's build, which the first of them starts: the services, with `State` and `Sockets`
  provided, then `routes`. Every handler and `run` shares it.
- A build that fails rejects the events awaiting it and is dropped with everything it built; the
  next event builds again from nothing. Nothing holds the object while it builds, so a build
  has no time limit of its own.
- Without `routes`, `fetch` answers 404, and nothing else is built for it.
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
events through `Sockets`.

```ts
export class Room extends DurableObject {
  readonly #memoMap = Layer.makeMemoMapUnsafe();
  readonly #services = Layer.mergeAll(services, ActionDurableObject.Sockets.layer).pipe(
    Layer.provideMerge(Layer.succeed(ActionDurableObject.State, this.ctx)),
  );
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
- A failed build stays failed: `ManagedRuntime` keeps its build's failure, and `toWebHandler`
  rejects every request with it, until the runtime evicts the instance. `handlers` builds
  again on the next event instead.
