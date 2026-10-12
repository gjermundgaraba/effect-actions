# Action in process

Call actions from your own code, such as a job or a test, and share one build of the
implementations between servers and jobs.

Read [Action.md](Action.md) first, and this page alone, in one tool call. When something fails,
search [Action-failures.md](Action-failures.md). Reading order: [README.md](README.md).

## API

Import `@gjermundgaraba/effect-actions/Action`. Its other exports are in [Action.md](Action.md#api).

| Export                                  | Purpose                                                                  |
| --------------------------------------- | ------------------------------------------------------------------------ |
| `client(implementations, { actions? })` | An Effect of a client running them in process: `client.<action>(input)`. |
| `layer(implementations)`                | Their builders as one layer: above several servers, each runs once.      |
| `Client<Apps>`                          | What `client` gives for the implementations `Apps`, one or a list.       |
| `ClientOptions`                         | What `client` takes: `actions`, the ones to call.                        |

## Call actions in process

`Action.client(implementations)` gives the methods `ActionHttp.client` gives. A call runs what a
remote call runs, without a transport: the input and the result pass through their JSON codecs,
and the authorizer runs before the handler.

```ts
const as = (user: keyof typeof users) => Effect.provideService(CurrentUser, users[user]);

const program = Effect.gen(function* () {
  const client = yield* Action.client(notes);

  return yield* client.createNote({ title: "Plan", body: "Draft" }).pipe(as("ada"));
}).pipe(Effect.scoped, Effect.provide(NoteStore.layerMemory));
```

Acquiring a client needs a `Scope`: under `it.effect` the test supplies it, as in
[notes-service/test/notes/notes.test.ts](node_modules/@gjermundgaraba/effect-actions/examples/notes-service/test/notes/notes.test.ts);
elsewhere `Effect.scoped` does, as in [kitchen-sink/src/agent.ts](node_modules/@gjermundgaraba/effect-actions/examples/kitchen-sink/src/agent.ts).

- **Provide the caller around each call, and startup services around the acquisition.** A call
  reads its own context, never the one the client was acquired in, so one client serves every
  caller ([assistant/test/identity/identity.test.ts](node_modules/@gjermundgaraba/effect-actions/examples/assistant/test/identity/identity.test.ts)).
- **Acquiring a client runs the builders**, and builds a built authorizer: it owes their startup
  services. Acquire it once, in a builder, a layer, or a scoped program such as a test. Never in
  a handler, which builds on every request.
- **Two acquisitions share a build only inside one layer graph**, such as under a layer provided
  around the program. With none around them, each builds its own.
- **Every implemented action has a method**, whether or not a surface serves it. `actions` lists
  the ones to call, and an implementation holding none of them is left unbuilt
  ([kitchen-sink/test/issues/issues.test.ts](node_modules/@gjermundgaraba/effect-actions/examples/kitchen-sink/test/issues/issues.test.ts)).
- **Test what an implementation does here**, and what a surface adds, its authentication,
  statuses and codecs, in memory ([Testing.md](Testing.md#test-routes-in-memory)). Assert on a
  failure as [Testing.md](Testing.md#assert-on-errors) says.

## Share one build across servers

Inside one `HttpRouter.serve` or one `Testing.layer`, a builder runs once, however many surfaces
serve it, a toolkit's `layer` provided to the routes included. Each builds its routes in a layer graph of its own, which reuses what is provided from
outside it and shares nothing it builds itself: a builder's run, a built authorizer, or a
service of yours such as an in-memory store.

- **With one server, put everything the process runs inside the layer it serves**, a job or an
  agent beside the routes included.
- **Otherwise, provide `Action.layer(implementations)` and the services they share above the
  server and its siblings**: a second server, a program beside it, several `Testing.layer`s.

```ts
// kitchen-sink/src/routes.ts
export const builders = Action.layer([...implementations, admin]);

// kitchen-sink/src/server.ts
Layer.mergeAll(
  HttpRouter.serve(publicRoutes).pipe(Layer.provide(listen(publicPort))),
  HttpRouter.serve(adminRoutes).pipe(Layer.provide(listen(adminPort))),
).pipe(Layer.provide(builders), Layer.provide(memory));
```

That is [kitchen-sink/src/routes.ts](node_modules/@gjermundgaraba/effect-actions/examples/kitchen-sink/src/routes.ts) and
[kitchen-sink/src/server.ts](node_modules/@gjermundgaraba/effect-actions/examples/kitchen-sink/src/server.ts), two ports;
[kitchen-sink/test/routes.test.ts](node_modules/@gjermundgaraba/effect-actions/examples/kitchen-sink/test/routes.test.ts) does it with two
`Testing.layer`s, asserting one run of a builder both ports serve.

- **A job merged beside `HttpRouter.serve`, with no `Action.layer` above both, shares the
  server's build only when its own side builds first.** Built after the routes, it builds
  again, with state of its own. Which builds first depends on timing: it can pass in a test and
  build twice once the job starts later.
- **`Action.layer` builds every implementation it is given**, those no surface serves included,
  so it owes their startup services.
- **Inside one layer graph, a builder runs with the services of whichever surface builds it
  first**, and services provided around one surface reach the others. Provide startup services
  once, for every surface.
- **Do not wrap a server in `Layer.fresh`**: two servers already share no build. It is only for
  two surfaces in one graph that must each have a build and startup services of their own.
