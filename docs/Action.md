# Action

The contract module, where every application starts. `Action.make` defines an action: a name,
schemas for its input, success and declared errors, whether it is read-only, and who may call
it. `Action.implement` binds handlers to contracts, with the authorizer every surface runs
before a protected action's handler. Every surface takes the implementation it returns, or a
list of them; `Action.client` calls them in process, and `Action.layer` shares their builders
between servers.

## API

Import `@gjermundgaraba/effect-actions/Action`.

| Export                                          | Purpose                                                                                      |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `make(name, options)`                           | Define a contract; its literal name, `readOnly` and `caller` stay typed.                     |
| `byName(actions)`                               | A list of actions keyed by name, each its exact contract: `contracts.getUser`.               |
| `implement(action, handler, { authorize })`     | Bind one handler, and a protected action's authorizer; returns one `Implementation`.         |
| `implement([actions], handlers, { authorize })` | Bind a record of handlers keyed by action name; returns one `Implementation` of all.         |
| `implement(actions, builder, options?)`         | Either form, with an Effect that builds the handler or record once per layer graph.          |
| `allowAll`                                      | The authorizer without a rule: every authenticated caller may call.                          |
| `Anyone`                                        | The caller of a public action, `caller: Action.Anyone`: anyone, signed in or not.            |
| `layer(implementations)`                        | Their builders as one layer: provided above several servers, each runs once for all.         |
| `client(implementations, { actions? })`         | An Effect of a client running them in process: `client.<action>(input)`.                     |
| `Image`                                         | A media field's schema, `{ data: Uint8Array, mimeType: string }`: an image.                  |
| `InvalidInput`, `Unauthenticated`, `Forbidden`  | The built-in errors: 400 with `issues`, 401, 403 with optional `scopes`; `message` defaults. |
| `InvalidInput.fromSchemaError(error)`           | The `InvalidInput` every surface answers a `Schema.SchemaError` with, `issues` given.        |
| `Issue`                                         | One of `InvalidInput`'s `issues`: a `path` into the input and a `message`.                   |
| `Refusal`                                       | `Unauthenticated \| Forbidden`, schema and type: all an authorizer may fail with.            |
| `BuiltIn`                                       | `InvalidInput \| Refusal`, schema and type: what any handler may fail with.                  |
| `Errors`                                        | A list of error schemas, as `error` holds it: `<E extends Action.Errors>`.                   |
| `Action`, `Any`, `Implementation`               | Concrete and erased contracts, and bound implementations.                                    |
| `Client<Apps>`                                  | What `client` gives for the implementations `Apps`, one or a list.                           |
| `AnyImplementation`, `AnyImplementation<A>`     | Any implementation, or any of actions `A`, erased: a generic helper's constraint.            |
| `BuildServices`, `BuildError`                   | What implementations' builders read and fail with at startup.                                |
| `implementation.actions`                        | Its exact contract values, as `Testing.mcpClient(notes.actions)` takes them.                 |
| `Handler`, `Authorize`                          | Typed handlers, and authorizers `(action) => Effect<void, Refusal, R>`.                      |
| `Handlers`                                      | A list's handlers keyed by name, for a builder written apart from `implement`.               |
| `Options`, `ClientOptions`, `Mcp`               | What `make` and `client` take, and `make`'s `mcp` options.                                   |

| Option        | Meaning                                                                                       |
| ------------- | --------------------------------------------------------------------------------------------- |
| `description` | Required. A model reads it beside the tool, and a CLI prints it as help.                      |
| `readOnly`    | Required: whether the action leaves its resource unchanged.                                   |
| `caller`      | Required: `Action.Anyone`, or the identity service a caller must have, such as `CurrentUser`. |
| `input`       | A schema or struct fields; omitted or `{}`, no arguments.                                     |
| `success`     | A schema or struct fields; omitted, the action returns nothing.                               |
| `error`       | The declared errors: one schema or a list; defaults to none.                                  |
| `mcp`         | The tool's MCP hints, in MCP's names, its `title` and `_meta`.                                |

## Define a contract

Write one `Action.make` per action in the domain's contract file, and export the domain's
actions as one `as const` list: `implement` and every surface take lists.

```ts
export const GetNote = Action.make("getNote", {
  description: "Read one of your notes.",
  input: { id: Schema.String },
  success: Note,
  error: NoteNotFound,
  readOnly: true,
  caller: CurrentUser,
});
```

Start from [quickstart/src/greeting/Greeting.ts](../examples/quickstart/src/greeting/Greeting.ts).
[notes-service/src/notes/Notes.ts](../examples/notes-service/src/notes/Notes.ts) adds declared
errors and the list, and [kitchen-sink/src/issues/Issues.ts](../examples/kitchen-sink/src/issues/Issues.ts)
uses every option.

- **The contract file imports no server code and no transport**, so a browser or a CLI can
  import it ([setup.md](setup.md#bundle-for-a-browser)).
- **The name** matches `[A-Za-z0-9_-]{1,128}` and is not `then`. It is the route
  segment, the client method, the tool name and, in kebab-case, the command, so it is unique
  within each binding, MCP endpoint, Toolkit, CLI and client that holds it.
- **For no arguments, omit `input`.** The action then accepts only `{}`. A `Schema.Struct({})`
  is kept as given: it accepts any value but `null`, and MCP refuses it as a tool's input,
  which must be one object with keys ([ActionMcp.md](ActionMcp.md#describe-tools-to-a-model)).
- **Annotate each declared error with `httpApiStatus`**, or HTTP answers it as a 422.
- **Give each declared error its own `_tag`.** A client decodes a failure by trying the
  action's error schemas in turn: two that share a `_tag`, or have none, are told apart by
  their other fields alone, the first that decodes winning.
- **Share options by spreading** a constant error array, or an `as const` object of several
  options, into each action (`IssueWriteErrors` and `change` in
  `kitchen-sink/src/issues/Issues.ts`).
- **Derive authorization from `readOnly`**, never from an `mcp` hint.
- **A contract does not say where it is served.** Each surface takes the list of actions it
  serves. Keep those lists in one file beside the contracts
  ([kitchen-sink/src/Actions.ts](../examples/kitchen-sink/src/Actions.ts)): an action added
  later is no tool until it is listed there.
- **List an action as a tool only where a model may hold what it takes and returns.** A tool
  call passes both through the model's context and records its arguments on the current span,
  a `Schema.Redacted` value included.
- **Surfaces match an implementation to a contract by object identity, never by name**:
  implement, bind and list the one exported value. Build lists from the contracts themselves:
  one narrowed at run time, by a filter or a conditional element, is still typed as holding
  every member.
- **`Action.Image` in a success is a media field**
  ([ActionMcp.md](ActionMcp.md#return-images-and-other-media)).

## Say who may call an action

Every contract states `caller`; there is no default. `Action.Anyone` makes a public action. An
identity service, `caller: CurrentUser`, makes a protected one: every surface requires that
identity, whether or not the handler reads it. A remote surface gets it by authenticating the
request ([Authentication.md](Authentication.md#declare-how-callers-sign-in)); on a local
surface the host provides it around each call
([ActionToolkit.md](ActionToolkit.md#name-the-caller), [ActionCli.md](ActionCli.md#name-the-caller)).

`CurrentUser` is in [notes-service/src/identity/Identity.ts](../examples/notes-service/src/identity/Identity.ts),
and a public action in [notes-service/src/status/Status.ts](../examples/notes-service/src/status/Status.ts).

- **Declare the identity as a `Context.Service`**, in a contract file, apart from its
  verifier. A `Context.Reference` is refused: its default would stand in for every caller who
  supplies none.
- **Never provide an identity, or a tenant, at startup**: not to a server's layer or root
  context, not to `Action.layer`, not around the acquisition of a client. A protected route
  still requires its authentication provider, and a public handler or a route of your own that
  reads the tag would serve every caller as that identity. The types check that a service is
  present, not where it came from. A test does the same: it serves protected routes behind an
  authentication provider, and each client sends its caller's credential
  ([Testing.md](Testing.md#test-as-a-signed-in-caller)).
- **One identity per action**, and every protected action one remote surface serves declares
  the same one. A tenant is a request-time requirement of the handler, not a second identity.
  A second audience takes its own identity, descriptor and binding (`Operator` in
  [kitchen-sink/src/admin/Admin.ts](../examples/kitchen-sink/src/admin/Admin.ts)).
- **No surface provides a public action an identity.** An action whose answer depends on the
  caller is protected.
- **A caller trusted on one surface is a trusted identity** ([CONTEXT.md](CONTEXT.md#terms));
  the same authorizer admits it
  ([assistant/src/identity/Identity.ts](../examples/assistant/src/identity/Identity.ts)).

## Implement actions

`Action.implement(action, handler)` binds one action, and `Action.implement(list, record)`
several, each handler keyed by its action's name. Either may instead be a builder: an Effect
that returns the handler or the record, which is how a handler gets a service.

```ts
export const notes = Action.implement(
  Notes,
  Effect.gen(function* () {
    const store = yield* NoteStore; // a startup service: yielded once

    return {
      // CurrentUser is a request-time requirement: yielded per call
      getNote: ({ id }) => Effect.flatMap(CurrentUser, (user) => store.get(user.id, id)),
      // ...one handler per action of the list
    };
  }),
  { authorize },
);
```

A plain handler is [quickstart/src/greeting/handlers.ts](../examples/quickstart/src/greeting/handlers.ts),
and the whole builder above [notes-service/src/notes/handlers.ts](../examples/notes-service/src/notes/handlers.ts).

- **One implementation may hold public and protected actions**, and actions only some
  surfaces serve: group by domain.
- **What the builder yields is shared by every call; what a handler yields is resolved per
  call.** An identity yielded in
  the builder becomes a startup requirement, which [nothing may provide](#say-who-may-call-an-action).
- **A builder runs once per layer graph**, however many surfaces serve its implementation
  ([Share one build across servers](#share-one-build-across-servers)). A local CLI command
  builds it on each invocation
  ([ActionCli.md](ActionCli.md#run-actions-as-local-commands)). Two `implement` calls are two
  builders, even of one builder Effect.
- **Each call has a scope of its own**, so a resource that must outlive a call is the
  builder's.
- **Pass the builder to `implement` itself.** Through `.pipe(...)` or a wrapper such as
  `Effect.withSpan(builder, name)`, an `Effect.fn` handler it returns takes an `any` input. A
  builder written apart returns its record `satisfies Action.Handlers<typeof actions>`.
- **Leave a handler's `Effect.fn` unnamed.** Each handler already runs in a span named after
  its action, and its log lines carry `action.name` and `action.read_only`.
- **Calling the function you passed to `implement` skips authorization.** Call the
  implementation through [`Action.client`](#call-actions-in-process).

## Authorize calls

An implementation that holds a protected action states `{ authorize }`: a function of the
called action that succeeds, or fails with a refusal. Every surface runs it before the handler,
and none has a policy of its own. An implementation of public actions alone takes none, and the authorizer
never runs for a public action.

```ts
export const authorize = Effect.fn("authorize")(function* (action: Action.Any) {
  const scope = action.readOnly ? scopes.read : scopes.write;
  const user = yield* CurrentUser;

  if (!user.scopes.includes(scope)) {
    return yield* new Action.Forbidden({ message: `Requires ${scope}.`, scopes: [scope] });
  }
});
```

That is [notes-service/src/identity/authorize.ts](../examples/notes-service/src/identity/authorize.ts).
An authorizer built from a service is
[assistant/src/identity/authorize.ts](../examples/assistant/src/identity/authorize.ts), and
`Action.allowAll` is in [kitchen-sink/src/identity/handlers.ts](../examples/kitchen-sink/src/identity/handlers.ts).

- **A call runs authentication, then over HTTP and RPC the layer's `middleware`, input
  decoding, the authorizer, then the handler**, each refusing before the next. So invalid input
  never reaches the authorizer: a caller it would refuse can still receive an `InvalidInput`
  describing the input's schema. To refuse before decoding, use that `middleware`
  ([ActionHttp.md](ActionHttp.md#serve-the-routes), [ActionRpc.md](ActionRpc.md#serve-the-rpcs)).
- **An authorizer fails only with `Action.Unauthenticated` or `Action.Forbidden`.** A
  `Forbidden` naming `scopes` is what an OAuth client re-authorizes on
  ([Authentication.md](Authentication.md#publish-oauth-discovery)).
- **What a plain authorizer yields is a request-time requirement of every surface.** To read a
  store, make `authorize` an Effect that yields the store once and returns the function, as a
  builder does. It is built once for each implementation stating it: keep state they share in
  a service it yields.
- **A limit, such as a rate limit, is not the authorizer's.** After decoding, on every
  surface, it is the handler's: it fails with an error the action declares, and its limiter is
  a startup service the builder yields, so every surface counts against one
  ([kitchen-sink/src/issues/write-limit.ts](../examples/kitchen-sink/src/issues/write-limit.ts)).
  Before decoding, it is that `middleware`, which may key it by the caller
  ([kitchen-sink/src/identity/quota.ts](../examples/kitchen-sink/src/identity/quota.ts)).
- **A check on one record belongs in the handler's data access**, which has the input and the
  data ([notes-service/src/notes/store.ts](../examples/notes-service/src/notes/store.ts)). A
  rule across callers, such as uniqueness, also lives in the service that holds the data,
  failing with an error the action declares.

## Fail with declared and built-in errors

A handler fails with the errors its action lists in `error`, and with the three built-in
errors, which every surface declares and every client decodes: never list those. Any other
failure does not compile. Forced through with a cast, each surface answers it its own way, an empty 500
over HTTP ([guarantees.md](guarantees.md#wire-behavior)).

- **Fail with `Action.InvalidInput` for input that decodes but cannot be served**, naming
  `issues` of your own, instead of declaring a second error for bad input
  ([kitchen-sink/src/attachments/handlers.ts](../examples/kitchen-sink/src/attachments/handlers.ts)).
- **For input you decode yourself**, such as a header or a route parameter, answer as the
  surfaces do: `Schema.decodeUnknownEffect(schema)(value).pipe(Effect.mapError(Action.InvalidInput.fromSchemaError))`.
- **Only the library's classes are built-in errors.** Failing with Effect's
  `HttpApiError.Forbidden`, or a `Forbidden` of your own, does not compile, and `make` refuses
  an `error` entry whose `_tag` is a built-in one.
- **Map another service's refusals before failing with them.** A handler calling another
  service through a client that decodes the built-in errors, such as `ActionHttp.client`, gets
  that service's `Unauthenticated` or `Forbidden` as a value it may fail with. Passed on, it
  is this server's own refusal: a caller whose token is valid is told to sign in again. Map it
  to an error the action declares, or to a defect.

## Call actions in process

`Action.client(implementations)` gives the methods `ActionHttp.client` gives. A call runs what
a remote call runs, without a transport:
the input and the result pass through their JSON codecs, and the authorizer runs before the
handler. Use it to test an implementation, and in a job or a command of your own.

```ts
const as = (user: keyof typeof users) => Effect.provideService(CurrentUser, users[user]);

const program = Effect.gen(function* () {
  const client = yield* Action.client(notes);

  return yield* client.createNote({ title: "Plan", body: "Draft" }).pipe(as("ada"));
}).pipe(Effect.scoped, Effect.provide(NoteStore.layerMemory));
```

Acquiring a client needs a `Scope`: under `it.effect` the test supplies it, as in
[notes-service/test/notes/notes.test.ts](../examples/notes-service/test/notes/notes.test.ts);
elsewhere `Effect.scoped` does, as in [kitchen-sink/src/agent.ts](../examples/kitchen-sink/src/agent.ts).

- **Provide the caller around each call, and startup services around the acquisition.** A call
  reads its own context, never the one the client was acquired in, so one client serves every
  caller ([assistant/test/identity/identity.test.ts](../examples/assistant/test/identity/identity.test.ts)).
- **Acquiring a client runs the builders**, and builds a built authorizer: it owes their
  startup services. Acquire it once, where builders live: in a builder, in a
  layer, or in a scoped program such as a test. Never in a handler, which builds on every
  request.
- **Two acquisitions share a build only inside one layer graph**, such as under a layer
  provided around the program. With none around them, each builds its own.
- **Every implemented action has a method**, whether or not a surface serves it. `actions`
  lists the ones to call, and an implementation holding none of them is left unbuilt
  ([kitchen-sink/test/issues/issues.test.ts](../examples/kitchen-sink/test/issues/issues.test.ts)).
- **Test what an implementation does here**, and what a surface adds, its authentication,
  statuses and codecs, in memory ([Testing.md](Testing.md#test-routes-in-memory)). Assert on a
  failure as [Testing.md](Testing.md#assert-on-errors) says.

## Share one build across servers

`HttpRouter.serve` and `Testing.layer` each build their routes in a layer graph of their own.
That graph reuses what is provided from outside it and shares nothing it builds itself: a
builder's run, a built authorizer, or a service of yours such as an in-memory store. One rule
places all of them:

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

[kitchen-sink/src/server.ts](../examples/kitchen-sink/src/server.ts) runs two ports this way, and
[kitchen-sink/test/routes.test.ts](../examples/kitchen-sink/test/routes.test.ts) two
`Testing.layer`s, asserting one run of a builder both ports serve.

- **A sibling given neither may build again, with state of its own.** The order
  `Layer.mergeAll` lists its layers in does not decide it: it builds them concurrently.
- **`Action.layer` builds every implementation it is given**, those no surface serves
  included, so it owes their startup services.
- **Inside one layer graph, a builder runs with the services of whichever surface builds it
  first**, and services provided around one surface reach the others. Provide startup services
  once, for every surface.
- **Do not wrap a server in `Layer.fresh`**: two servers already share no build. It is only
  for two surfaces in one graph that must each have a build and startup services of their own.

## Examples

| File                                                                                             | Shows                                                              |
| ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------ |
| [quickstart/src/greeting/Greeting.ts](../examples/quickstart/src/greeting/Greeting.ts)           | The smallest contract, a public one.                               |
| [notes-service/src/notes/Notes.ts](../examples/notes-service/src/notes/Notes.ts)                 | Contracts with declared errors and statuses, exported as a list.   |
| [notes-service/src/identity/Identity.ts](../examples/notes-service/src/identity/Identity.ts)     | An identity service and a protected action without input.          |
| [notes-service/src/notes/handlers.ts](../examples/notes-service/src/notes/handlers.ts)           | A builder: a service once, the caller per call.                    |
| [notes-service/src/status/handlers.ts](../examples/notes-service/src/status/handlers.ts)         | A public action's implementation, without `authorize`.             |
| [notes-service/src/identity/authorize.ts](../examples/notes-service/src/identity/authorize.ts)   | A rule from `readOnly`, refusing with the missing scope.           |
| [notes-service/src/notes/store.ts](../examples/notes-service/src/notes/store.ts)                 | Record-level checks in the data access.                            |
| [notes-service/test/notes/notes.test.ts](../examples/notes-service/test/notes/notes.test.ts)     | `Action.client` in a test, a caller per call.                      |
| [assistant/src/identity/Identity.ts](../examples/assistant/src/identity/Identity.ts)             | A trusted identity only a host builds.                             |
| [assistant/src/identity/authorize.ts](../examples/assistant/src/identity/authorize.ts)           | An authorizer built once from a service.                           |
| [assistant/test/identity/identity.test.ts](../examples/assistant/test/identity/identity.test.ts) | Startup services around the acquisition, the caller around a call. |
| [kitchen-sink/src/issues/Issues.ts](../examples/kitchen-sink/src/issues/Issues.ts)               | A shared error list, an option bundle, `mcp`, a defaulted field.   |
| [kitchen-sink/src/Actions.ts](../examples/kitchen-sink/src/Actions.ts)                           | Which actions each surface gets, and why one is no tool.           |
| [kitchen-sink/src/issues/guide.ts](../examples/kitchen-sink/src/issues/guide.ts)                 | `byName`.                                                          |
| [kitchen-sink/src/issues/write-limit.ts](../examples/kitchen-sink/src/issues/write-limit.ts)     | A rate limit shared by several handlers.                           |
| [kitchen-sink/src/attachments/handlers.ts](../examples/kitchen-sink/src/attachments/handlers.ts) | `InvalidInput` with `issues`, from a handler.                      |
| [kitchen-sink/src/identity/handlers.ts](../examples/kitchen-sink/src/identity/handlers.ts)       | `allowAll`.                                                        |
| [kitchen-sink/src/routes.ts](../examples/kitchen-sink/src/routes.ts)                             | `Action.layer`, as `builders`, for two ports.                      |
| [kitchen-sink/test/routes.test.ts](../examples/kitchen-sink/test/routes.test.ts)                 | Two `Testing.layer`s sharing one build.                            |
| [kitchen-sink/src/agent.ts](../examples/kitchen-sink/src/agent.ts)                               | `Action.client` in a program.                                      |
| [kitchen-sink/test/issues/issues.test.ts](../examples/kitchen-sink/test/issues/issues.test.ts)   | `client`'s `actions`; a limit counted across actions.              |

The index in [kitchen-sink/README.md](../examples/kitchen-sink/README.md#index) maps every export
and option to a file.

## Failure modes

### At `make`

- `Invalid action name: <name>` thrown: the name is empty, longer than 128 characters, `then`, or has another character.
- `Property 'readOnly' is missing`, or `Invalid readOnly: <value>` thrown for a caller the compiler never sees: every action declares whether it is read-only. There is no default.
- `Property 'caller' is missing`, or `Missing caller: declare Action.Anyone or an identity service key` thrown: the contract does not state who may call it. Give `caller: Action.Anyone` or an identity service.
- `Type ... is not assignable to type '"An identity is a Context.Service, not a Context.Reference"'`, or `Invalid caller: an identity is a Context.Service, not a Context.Reference` thrown: `caller` is a `Context.Reference`. Declare the identity with `Context.Service`.
- `'readOnlyHint' does not exist in type 'Mcp'`, or `Type 'true' is not assignable to type 'never'` on `readOnlyHint` beside another hint: a tool's read-only hint is its action's `readOnly`. Set `readOnly` instead.
- `'<key>' does not exist in type 'Options'`, or `in type 'Mcp'`, or `Type '...' is not assignable to type 'never'` on the key: an option or hint `make` does not take, or a misspelled one, such as `destructive` for `destructiveHint`.
- `Type 'H' is not assignable to type 'H & ...'`, where `H` is a helper's type parameter, as in `<const H extends Action.Mcp>(mcp: H)`: `make` refuses options a type parameter stands for. Type the parameter `Action.Mcp`; an action's type carries no `mcp` types. A constant object spread into the options is read as written.
- A type error on `error`, `... is not assignable to type 'readonly never[]'` or naming the remaining errors: it lists a built-in error. Drop it; a handler may fail with it anyway.
- `Action "<name>": error _tag "Forbidden" is built in, and declared on every surface` thrown: an entry of `error`, or a member of a union there, encodes with the `_tag` `InvalidInput`, `Unauthenticated` or `Forbidden`. Drop a built-in error; rename an error of your own.
- `ReferenceError` thrown: an entry of `error` is a `Schema.suspend` whose thunk reads a `const` declared further down. `make` reads every error's `_tag` when it is called; declare the error first.

### At `implement`

- `... is not assignable to parameter of type 'ProtectedActionsTakeAuthorize'`, ending `Type 'typeof CurrentUser' is not assignable to type 'unique symbol'`: the target holds a protected action and states no `authorize`. Pass `{ authorize }`, or `{ authorize: Action.allowAll }`. Plain JavaScript throws `Protected actions require authorize, or Action.allowAll`.
- `No overload matches this call`, ending `... is not assignable to type '"A public-only target takes no authorize"'`, or that message thrown from plain JavaScript: an implementation of public actions alone states `authorize`, which nothing would run. Drop it, or make the contract protected.
- `Missing authorize: pass an authorization function, or Action.allowAll` thrown, or the layer build dies with it: `authorize` is neither a function nor an Effect building one, or that Effect built something else.
- `No overload matches this call`, ending `Type 'undefined' is not assignable to type 'Authorizer<...>'`: an authorizer that may be `undefined`. Write `enabled ? authorize : Action.allowAll`.
- `Parameter 'action' implicitly has an 'any' type`, or an `Effect.fn` authorizer whose `action` is `any`, where it is defined apart from `implement`: annotate it, `(action: Action.Any)`.
- `Type 'X' is not assignable to type 'Forbidden | Unauthenticated'`, ending `Property '"~builtIn"' is missing in type 'X'`: the authorizer fails with `X`, which is not a refusal. A limit or another failure callers should see is the handler's: declare `X` in the action's `error` and fail with it there.
- `Effect<..., X, ...> is not assignable`: the handler fails with an undeclared error `X`. Add it to the action's `error`, or handle it.
- `Property 'x' is missing in type`, or `Missing handlers: <names>` thrown, also when a builder's layer builds: the record has no own-property function for those actions. Add them to the record itself, not to a prototype.
- `Unknown handlers: <keys>` thrown, also when a builder's layer builds, or a type error naming a key: the record has a handler for an action not in this `implement` call. Remove it, or add its action to the list.
- `Duplicate action: <name>` thrown, by `byName` too: the list names one action twice.
- `'<name>' implicitly has type 'any' because it does not have a type annotation and is referenced directly or indirectly in its own initializer` (TS7022), or, with the types bypassed, an acquisition that never completes: a builder acquires a client of its own implementation, directly or through another builder. Call the services both use instead.
- A handler receives a string where a number was expected: the schema is `Schema.String`, not a transforming codec such as `Schema.FiniteFromString`.

### Where an implementation is served

- `Type 'CurrentUser' is not assignable to type 'never'`, or `Request<"Requires", CurrentUser>` still owed, for a layer serving only public actions: a public action's handler reads the identity, which no surface provides to a public action. Make the action protected.
- A service is resolved once and shared across requests when it should be per request: it was yielded in the builder, or in the Effect building the authorizer. Move the `yield*` into the handler or the authorizer.
- `HttpRouter.Request<"Requires", X>` still owed, or `Type 'X' is not assignable to type 'never'` at `runMain`, although `X`, a store the authorizer reads, is provided at startup: the authorizer yields it on every call. Yield it in an Effect that builds the authorizer ([Authorize calls](#authorize-calls)).
- `unknown` among a surface's requirements, and a type error where it is served or run, such as `Argument of type 'Layer<never, unknown, unknown>' is not assignable` at `HttpRouter.toWebHandler` or `Type 'unknown' is not assignable to type 'never'`: the implementations are typed `Action.AnyImplementation`, as a helper's parameter or a list's annotation. Make the helper generic over them, `<const Apps extends Action.AnyImplementation | ReadonlyArray<Action.AnyImplementation>>(apps: Apps)`, or drop the annotation.
- `Request<"Requires", unknown>` where an implementation is served, or `unknown` among the services a call or a run still requires: TypeScript inferred no requirements for a handler of a record. A data-first call whose type takes a parameter from no argument does it, `Effect.catchTag(effect, tag, f)` for one. Write that handler's Effect `effect.pipe(Effect.catchTag(tag, f))`, or as a generator.
- A builder runs twice, or a job, an agent or a second server reads other state than the routes, such as an empty in-memory store: it is merged beside `HttpRouter.serve`, whose layer graph builds on its own. Put it inside the layer the server serves, or provide `Action.layer` and the services they share above both ([Share one build across servers](#share-one-build-across-servers)).
- Two surfaces in one layer graph, each given startup services of its own, both answer with one surface's: a builder runs once per layer graph, with the services of its first build. Provide the services once; where the surfaces must differ, wrap each in `Layer.fresh`, providing what they share, authentication included, outside it, or give each an implementation of its own.
- `Not an implementation made by this Action.implement: is effect-actions installed twice?` thrown by a surface, `client` or `layer`, or by a local CLI command when it runs: another installed copy of the package made the implementation, or the value is a copy of one, such as a spread. Install one copy of the package, since contracts and bindings cross copies but implementations do not, and pass the value `implement` returned.

### At `client` and its calls

- `Listed in actions, but no implementation holds it: <names>` thrown: a listed action is none of the implementations'. Pass the implementation holding it, or check that the contract values are the ones it implemented.
- `Duplicate action: <name>` thrown: two of the implementations implement an action of that name. Two contracts sharing a name are told apart by `actions`, listing one; two implementations of one contract are not: pass one.
- `Type 'CurrentUser' is not assignable to type 'never'` where a program calling a client runs: a protected action's call owes the caller, and nothing provides one around it. Provide it around the call; provided around the acquisition, it reaches no call.
- A type error that a program still requires `Scope`: acquiring a client builds, as a layer does. Acquire it in a builder or a layer, or run the program in `Effect.scoped`.
- A builder runs on every request, or a route owes `HttpRouter.Request<"Requires", X>` for `X`, a service its builder yields: a handler acquires a client per request. Acquire it in the builder, and call it in the handler.
- A call dies with a `SchemaError`: the handler's success, or what it fails with, does not pass through its codec. A failure follows the `SchemaError` in the cause, as `Cause.pretty` shows. Return what the success schema accepts, and fail with an error the action declares.
- `InvalidInput` with `Expected <Class>` from a call given a plain object: the input is a class, which encodes only its instances. Pass `new Class({ ... })`.
