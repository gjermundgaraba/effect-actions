# Action

`Action.make` defines an action, and `Action.implement` binds handlers and an authorizer to
contracts: every surface takes the implementation it returns, or a list of them.

Read this page alone, in one tool call: pages read together are cut. When something fails,
search [Action-failures.md](Action-failures.md). Reading order: [README.md](README.md).

## API

Import `@gjermundgaraba/effect-actions/Action`.

| Export                                         | Purpose                                                      |
| ---------------------------------------------- | ------------------------------------------------------------ |
| `make(name, options)`                          | Define a contract.                                           |
| `byName(actions)`                              | A list of actions keyed by name, each its exact contract.    |
| `implement(actions, handlers, { authorize })`  | Bind a handler, a record of them, or a builder of either.    |
| `allowAll`                                     | The authorizer without a rule: any authenticated caller.     |
| `Anyone`                                       | The `caller` of a public action: anyone, signed in or not.   |
| `client`, `layer`, `Client`, `ClientOptions`   | In [Action-in-process.md](Action-in-process.md#api).         |
| `Image`                                        | A media field's schema: `data` bytes and a `mimeType`.       |
| `InvalidInput`, `Unauthenticated`, `Forbidden` | Built-in errors: 400 with `issues`, 401, 403 with `scopes`.  |
| `InvalidInput.fromSchemaError(error)`          | What every surface answers a `Schema.SchemaError` with.      |
| `Issue`                                        | One of `InvalidInput`'s `issues`: a `path` and a `message`.  |
| `Refusal`                                      | `Unauthenticated \| Forbidden`: an authorizer's failures.    |
| `BuiltIn`                                      | `InvalidInput \| Refusal`: what any handler may fail with.   |
| `Errors`                                       | A list of error schemas, as `error` holds it.                |
| `Action`, `Any`, `Implementation`              | Concrete and erased contracts, and bound implementations.    |
| `AnyImplementation`, `AnyImplementation<A>`    | Any implementation, or any of actions `A`, erased.           |
| `BuildServices`, `BuildError`                  | What builders read and fail with at startup.                 |
| `implementation.actions`                       | Its exact contracts, as `Testing.mcpClient` takes them.      |
| `Handler`, `Handlers`, `Authorize`             | A typed handler, a list's record of them, and an authorizer. |
| `Options`, `Mcp`                               | What `make` takes, and its `mcp` options.                    |

| Option        | Meaning                                                        |
| ------------- | -------------------------------------------------------------- |
| `description` | Required. A model reads it beside the tool; a CLI prints it.   |
| `readOnly`    | Required: whether the action leaves its resource unchanged.    |
| `caller`      | Required: `Action.Anyone`, or the caller's identity service.   |
| `input`       | A schema or struct fields; omitted, no arguments.              |
| `success`     | A schema or struct fields; omitted, nothing is returned.       |
| `error`       | The declared errors: one schema or a list; defaults to none.   |
| `mcp`         | The tool's MCP hints, in MCP's names, its `title` and `_meta`. |

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

Start from [quickstart/src/greeting/Greeting.ts](https://github.com/gjermundgaraba/effect-actions/blob/main/examples/quickstart/src/greeting/Greeting.ts).
[notes-service/src/notes/Notes.ts](https://github.com/gjermundgaraba/effect-actions/blob/main/examples/notes-service/src/notes/Notes.ts) adds declared
errors and the list, and [kitchen-sink/src/issues/Issues.ts](https://github.com/gjermundgaraba/effect-actions/blob/main/examples/kitchen-sink/src/issues/Issues.ts)
uses every option, sharing some by spreading a constant (`IssueWriteErrors`, `change`).

- **The contract file imports no server code and no transport**, so a browser or a CLI can
  import it ([setup.md](setup.md#bundle-for-a-browser)).
- **The name** matches `[A-Za-z0-9_-]{1,128}`, is not `then`, and is unique within each binding,
  MCP endpoint, Toolkit, CLI and client holding it.
- **For no arguments, omit `input`.** A `Schema.Struct({})` accepts any value but `null`, and MCP
  refuses it as a tool's input ([ActionMcp.md](ActionMcp.md#describe-tools-to-a-model)).
- **A field callers may omit is `Schema.optional`.** One with a decoding default (`limit` in
  `Issues.ts`) is still stated by a typed client given an argument
  ([ActionHttp.md](ActionHttp.md#call-the-api-from-effect)).
- **An action's `name`, `input`, `success`, `error` and `readOnly` are public**: reuse them, as
  in `Schema.Array(SaveLink.input)`.
- **Annotate each declared error with `httpApiStatus`**, or HTTP answers it as a 422.
- **Give each declared error its own `_tag`**: a client tells errors sharing one, or having
  none, apart by their other fields alone, the first that decodes winning.
- **A contract does not say where it is served**: each surface takes a list of actions. Keep
  those lists in one file beside the contracts
  ([kitchen-sink/src/Actions.ts](https://github.com/gjermundgaraba/effect-actions/blob/main/examples/kitchen-sink/src/Actions.ts)): an action added
  later is no tool until listed there.
- **List an action as a tool only where a model may hold what it takes and returns.** A tool
  call passes both through the model's context and records its arguments on the current span,
  a `Schema.Redacted` value included.
- **Surfaces match an implementation to a contract by object identity, never by name**:
  implement, bind and list the one exported value. A list narrowed at run time, by a filter or a
  conditional element, is still typed as holding every member.

## Say who may call an action

`caller: Action.Anyone` makes a public action. An identity service, `caller: CurrentUser`, makes
a protected one: every surface requires that identity, whether or not the handler reads it. A
remote surface gets it by authenticating the request
([Authentication.md](Authentication.md#declare-how-callers-sign-in)); on a local surface the
host provides it ([ActionToolkit.md](ActionToolkit.md#name-the-caller),
[ActionCli.md](ActionCli.md#name-the-caller), [ActionMcp.md](ActionMcp.md#serve-tools-over-stdio)).

`CurrentUser` is in [notes-service/src/identity/Identity.ts](https://github.com/gjermundgaraba/effect-actions/blob/main/examples/notes-service/src/identity/Identity.ts),
and a public action in [notes-service/src/status/Status.ts](https://github.com/gjermundgaraba/effect-actions/blob/main/examples/notes-service/src/status/Status.ts).

- **Declare the identity as a `Context.Service`**, in a contract file, apart from its verifier.
- **Never provide an identity, or a tenant, at startup**: not to a server's layer or root
  context, not to `Action.layer`, not around the acquisition of a client. A public handler or a
  route of your own reading the tag would serve every caller as that identity, and the types do
  not stop it. A test sends each caller's credential instead
  ([Testing.md](Testing.md#test-as-a-signed-in-caller)).
- **One identity per action**, and every protected action one remote surface serves declares
  the same one. A tenant is a request-time requirement of the handler, not a second identity.
  A second audience takes its own identity, descriptor and binding (`Operator` in
  [kitchen-sink/src/admin/Admin.ts](https://github.com/gjermundgaraba/effect-actions/blob/main/examples/kitchen-sink/src/admin/Admin.ts)).
- **No surface provides a public action an identity.** An action whose answer depends on the
  caller is protected.
- **One protected contract serves callers with a token over HTTP and a local host without
  one**, never a public copy of it: the host provides the caller around `runStdio`
  ([notes-service/src/stdio.ts](https://github.com/gjermundgaraba/effect-actions/blob/main/examples/notes-service/src/stdio.ts)).

## Implement actions

`Action.implement` binds a handler to one action, or a record of handlers keyed by name to a
list. Either may instead be a builder: an Effect that returns the handler or the record, which
is how a handler gets a service.

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

A plain handler is [quickstart/src/greeting/handlers.ts](https://github.com/gjermundgaraba/effect-actions/blob/main/examples/quickstart/src/greeting/handlers.ts),
and the whole builder above [notes-service/src/notes/handlers.ts](https://github.com/gjermundgaraba/effect-actions/blob/main/examples/notes-service/src/notes/handlers.ts).

- **One implementation may hold public and protected actions**, and actions only some
  surfaces serve: group by domain.
- **What the builder yields is shared by every call; what a handler yields is resolved per
  call**, as the caller must be.
- **A builder runs once per layer graph**, however many surfaces serve its implementation. Two
  servers are two graphs
  ([Share one build across servers](Action-in-process.md#share-one-build-across-servers)), and
  two `implement` calls are two builders, even of one builder Effect.
- **Each call has a scope of its own**, so a resource that must outlive a call is the
  builder's.
- **Pass the builder to `implement` itself.** Through `.pipe(...)` or a wrapper such as
  `Effect.withSpan(builder, name)`, an `Effect.fn` handler it returns takes an `any` input. A
  builder written apart returns its record `satisfies Action.Handlers<typeof actions>`.
- **Leave a handler's `Effect.fn` unnamed**: each handler already runs in a span named after its
  action, and its log lines carry `action.name` and `action.read_only`.
- **Calling the function you passed to `implement` skips authorization.** Call the
  implementation through [`Action.client`](Action-in-process.md#call-actions-in-process).

## Authorize calls

An implementation holding a protected action states `{ authorize }`: a function of the called
action that succeeds, or fails with a refusal. Every surface runs it before the handler, and
none has a policy of its own. An implementation of public actions alone takes none
([notes-service/src/status/handlers.ts](https://github.com/gjermundgaraba/effect-actions/blob/main/examples/notes-service/src/status/handlers.ts)), and
the authorizer never runs for a public action.

```ts
export const authorize = Effect.fn("authorize")(function* (action: Action.Any) {
  const scope = action.readOnly ? scopes.read : scopes.write;
  const user = yield* CurrentUser;

  if (!user.scopes.includes(scope)) {
    return yield* new Action.Forbidden({ message: `Requires ${scope}.`, scopes: [scope] });
  }
});
```

That is [notes-service/src/identity/authorize.ts](https://github.com/gjermundgaraba/effect-actions/blob/main/examples/notes-service/src/identity/authorize.ts).
Derive the rule from `action.readOnly`, never from an `mcp` hint: changing an action's
`readOnly` then changes who may call it.

- **A call runs authentication, then over HTTP and RPC the layer's `middleware`, input
  decoding, the authorizer, then the handler**, each refusing before the next. So a caller the
  authorizer would refuse can still receive an `InvalidInput` describing the input's schema. To
  refuse or limit before decoding, use that `middleware`
  ([ActionHttp.md](ActionHttp.md#serve-the-routes), [ActionRpc.md](ActionRpc.md#serve-the-rpcs)).
- **Name `scopes` in a `Forbidden` only where re-authorizing can grant them.** An OAuth
  challenge answers them, which a client follows only where the server publishes discovery
  ([Authentication.md](Authentication.md#publish-oauth-discovery)); with fixed tokens, such as
  API keys, name none. Without scopes it is a 403 over HTTP and, over MCP, an `isError` tool
  result in a 200 ([guarantees.md](guarantees.md#wire-behavior)).
- **What a plain authorizer yields is a request-time requirement of every surface.** To read a
  store, make `authorize` an Effect that yields the store once and returns the function, as a
  builder does
  ([assistant/src/identity/authorize.ts](https://github.com/gjermundgaraba/effect-actions/blob/main/examples/assistant/src/identity/authorize.ts)). It
  is built once for each implementation stating it: keep state they share in a service it
  yields.
- **A limit, such as a rate limit, is the handler's, not the authorizer's.** It fails with an
  error the action declares, and its limiter is a service the builder yields
  ([kitchen-sink/src/issues/write-limit.ts](https://github.com/gjermundgaraba/effect-actions/blob/main/examples/kitchen-sink/src/issues/write-limit.ts)):
  a service is shared wherever it is provided
  ([kitchen-sink/src/memory.ts](https://github.com/gjermundgaraba/effect-actions/blob/main/examples/kitchen-sink/src/memory.ts)), state kept in a
  builder only within one layer graph.
- **A check on one record belongs in the handler's data access**
  ([notes-service/src/notes/store.ts](https://github.com/gjermundgaraba/effect-actions/blob/main/examples/notes-service/src/notes/store.ts)). So does a
  rule across callers, such as uniqueness.

## Fail with declared and built-in errors

A handler fails with the errors its action lists in `error`, and with the three built-in
errors, which every surface declares and every client decodes: never list those. No other
failure compiles. What each surface answers is in [guarantees.md](guarantees.md#wire-behavior).

- **Fail with `Action.InvalidInput` for input that decodes but cannot be served**, naming
  `issues` of your own, instead of declaring a second error for bad input
  ([kitchen-sink/src/attachments/handlers.ts](https://github.com/gjermundgaraba/effect-actions/blob/main/examples/kitchen-sink/src/attachments/handlers.ts)).
- **For input you decode yourself**, such as a header or a route parameter, answer as the
  surfaces do: `Schema.decodeUnknownEffect(schema)(value).pipe(Effect.mapError(Action.InvalidInput.fromSchemaError))`.
- **Map another service's refusals before failing with them.** A client that decodes the
  built-in errors, such as `ActionHttp.client`, hands a handler that service's `Unauthenticated`
  or `Forbidden`. Passed on, it is this server's own refusal: a caller whose token is valid is
  told to sign in again. Map it to an error the action declares, or to a defect.
- **Map that client's `HttpClientError` and `SchemaError` to one declared error a caller can
  act on** ([mcp-tools/src/printers/farm.ts](https://github.com/gjermundgaraba/effect-actions/blob/main/examples/mcp-tools/src/printers/farm.ts)). As
  defects, a model reads only a generic text.
