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
  ([Share one build across servers](Action-in-process.md#share-one-build-across-servers)). A local CLI command
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
  implementation through [`Action.client`](Action-in-process.md#call-actions-in-process).

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
