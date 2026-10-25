# Changelog

## Unreleased

### Breaking changes

**A verifier or a handler reading `HttpServerRequest` over `ActionRpc` reads one holding the
message's headers**, a socket's upgrade headers before its own, at `/`, with no query or body, on
every protocol, and `ActionRpc.layer` no longer owes it. A protocol that gives a call no request, a
socket server or a protocol passing values, made such a verifier or handler die with `Service not
found`, answered `Internal server error`, so an application kept a second provider for those
surfaces; over `RpcServer.layerProtocolHttp` and Effect's WebSocket it read the router's request
instead.

- Migrate: judge a request's path or query, or a credential in its query, in router middleware,
  which runs with the real request, not in the verifier or the handler.

**`ActionMcp.McpCallError` has a reason `FrameTooLarge`**: an endpoint's event stream holding
more than the 10 MiB a client keeps with no frame ending fails the call with it, where it failed
with `NoReply`.

- Migrate: a match over `reason` that names every member names `FrameTooLarge` too.

**`ActionRpc.layer` and `ActionRpc.client` refuse a codec that does not keep a JSON value as it
is**, such as schema-binary's: `client` now refuses one too, as it is made, and both carry the
binding's actions and event types as JSON under any other codec, so a protocol passing values, such
as a Durable Object stub's, which `layer` refused before, works; native `rpcs` keep the protocol's
own codec. The message, the same for both, is
`ActionRpc puts JSON in a protocol's messages, which this protocol's codec does not keep as it is (…)`,
naming the codecs to provide; `layer`'s was `ActionRpc serves a protocol speaking JSON: …`.

- Migrate: give a client `RpcSerialization.layerJson` or `layerNdjson`, and update code matching
  `layer`'s old message.

**`ActionRpc.client`'s message for a binding whose group lacks an rpc** names "the rpc of this
action" (or native rpc), where it named "this action's rpc".

- Migrate: update code matching the old fragment.

### Additions

**Native rpcs beside actions.** `ActionRpc.make` takes `rpcs`, a native `RpcGroup` served beside
the actions on the same protocol, with its own schemas, such as one that
streams. Under the binding's `authentication`, each of their messages authenticates as a
protected action's does, a refusal failing the call with `Unauthenticated`; the binding's
`rpcs` holds them behind that middleware, and the host implements them with
`Rpc.rpcs.toLayer(handlers)`, which `ActionRpc.layer` requires. `ActionRpc.client` has their
methods beside the actions'. A native rpc named after an action, `then` or
`watch` is refused as the binding is made. Guide: `docs/ActionRpc.md#serve-the-rpcs`.

**`ActionRpc.unaryProtocol`** is the key a protocol answering each call once sets to `true` on
its `RpcServer.Protocol` service: `layer` then
fails its build serving a streaming action or a native stream rpc, where one
would be answered with a defect at its first element, or wait for good.

**`ActionRpc.reconnectUntil(...codes)`**, a socket client's `retryPolicy` that stops
connecting again once the server closes the socket with one of `codes`, and is otherwise
Effect's own default. Guide: `docs/ActionRpc.md#call-the-rpcs`.

**Progress.** `Action.make` takes `progress`, a schema or struct fields: the handler reports
values through its second argument, `{ progress }`, without waiting for the caller, and a
client's call takes `{ onProgress }` after its input. Progress is lossy: a caller falling behind
loses the oldest values, never the answer; an `onProgress` that fails is logged, and the call
answers. In process the values reach `onProgress` directly;
over HTTP a request accepting `text/event-stream` is answered with an SSE stream of `progress`
events, then a `final` one holding the answer, which `ActionHttp.client` always asks for, dropping
the values where the call gives no `onProgress`; over RPC such an action is a stream rpc of `Progress` elements, then a
`Final`; over MCP each value is `notifications/progress` on the call's `progressToken`, which
`ActionMcp.client` sends when the call gives `onProgress`; a toolkit streams each as a preliminary
result, `{ _tag: "Progress", value }`, its tool's success that or `success`; a command prints each value as
a line of JSON on stderr. Guide: `docs/Action-streams.md#report-progress`; example: kitchen-sink's
`exportIssues`.

- An action declaring `progress` and no `success` answers an HTTP request without the stream with
  an empty 204, where one without `progress` answers an empty 200: `HttpApi` cannot stream at the
  status of an empty answer.

**Streamed answers.** `Action.Stream(element)`, a schema or struct fields, whose type is
`Action.StreamOf`, as an action's `success` makes its handler return a `Stream` of elements, which may fail with the action's
errors, and every client's call return one; with `progress`, its values reach `onProgress`
beside the elements. In process the stream runs in a scope of its own, closed when the caller
stops reading; over HTTP the route answers an SSE stream of `element` events, and `progress`
ones where declared, a failure before the first event answering its status; over RPC such an
action is a stream rpc of `Element` elements, and `Progress` ones; a command prints each element
as a line of JSON on stdout, or `render`'s text of it. A tool answers one result, so
`ActionMcp.layerHttp`, `runStdio` and `ActionToolkit.make` answer the elements collected into one
array once the stream ends, a stream that never ends never answering, and `ActionMcp.client`'s
method streams that array again, so every client's call of such an action returns a `Stream`.
Guide: `docs/Action-streams.md#answer-a-stream`; example: kitchen-sink's `exportIssues`.

### Other changes

- **`ActionMcp` no longer records a tool call's arguments on its span**, only the tool's name,
  as HTTP records no body: a credential or a `Schema.Redacted` value among them reached every
  trace exported. `ActionToolkit` still records them, as Effect's toolkit does.
- **`ActionHttp.client` sends `Accept: application/json, text/event-stream` with every request**,
  so the route of an action declaring `progress` answers it the event stream; every other route
  answers as before.
- **An `ActionMcp.McpCallError`'s `body` from an event stream holds the data of its frames**, one
  per line, without their `data:` framing and without its `notifications/progress` frames.
- kitchen-sink has `exportIssues`, an action answering a stream of issues with progress, under an
  export limit.

## 0.20.0

Built and tested against `effect` and `@effect/platform-node` `4.0.6`. The `effect` peer stays
`~4.0.4`: what changed below holds on every 4.0 patch from 4.0.4, and where Effect 4.0.6 answers
differently from earlier patches, each entry says so.

### Breaking changes

**Node 26 or later.** `engines.node` is `>=26`, where it accepted Node 22.12 and 24 as well. The
package is built, typed and tested against Node 26 alone.

### Other changes

- An MCP endpoint answers a body over `HttpServerRequest.MaxBodySize` as an action route does:
  on Node from Effect 4.0.6, an empty 413, where the endpoint read it as a body that is not JSON
  and answered a JSON-RPC `-32700` in a 200. Under Effect 4.0.4 and 4.0.5, Node still closes
  such a request's connection unanswered, as before; `ActionHttp.layer`'s JSDoc says both.
- `runStdio` answers the requests after a line of stdin that is not JSON, as it says, under
  Effect 4.0.6 too: there Effect's stdio transport fails on such a line, and its retry drops the
  rest of what it had read, so the next request went unanswered. Such a line, or a blank one,
  no longer reaches the transport.
- An MCP tool's `inputSchema` and `outputSchema` list a named root schema's definition under
  `$defs` only where something refers to it, such as a recursive root, and leave out an empty
  `$defs`, as Effect's own `McpServer.toolkit` does from 4.0.6.
- From Effect 4.0.6 a failure beside a defect, a dying finalizer's or a concurrent sibling's, is
  a defect too, so a handler failing with a declared error while its finalizer dies answers as a
  defect on every surface, an empty 500 over HTTP. The library keeps a cause that holds both,
  built so, whole, as before.
- The request policy of `docs/Authentication-advanced.md` and `kitchen-sink` says why it lists
  the public URL's origin by name: behind a proxy ending TLS, a request's own origin, from its
  `originalUrl`, is an `http:` one from Effect 4.0.6, which takes the connection's scheme
  whatever `X-Forwarded-Proto` says. A policy accepting only the request's own origin refuses
  its site's pages there; `kitchen-sink` tests the proxied case.
- `ActionCli.command`'s JSDoc says Effect CLI styles what it prints, a failure's JSON included,
  on a terminal and, from Effect 4.0.6, wherever `FORCE_COLOR` forces colour, and how to get
  plain text there.

## 0.19.0

### Breaking changes

**A `_tag` names one error schema in a call, a built-in error's included.** `Action.make`,
`Authentication.make`, `ActionHttp.make` and `ActionRpc.make` check what each call can fail with,
the built-in errors, the action's, the binding's `error` and a protected action's
authentication's, and throw
`… error _tag "<tag>" names two error schemas, which a client cannot tell apart (…)` where two
different schemas share one. One schema is each union member, compared by identity, unless the union has its own
`httpApiStatus`, checks or a transformation, which make it one schema: one reached twice, listed
again, through a `Schema.Union` or a `Schema.suspend`, is one; two declared alike are two. This reverses 0.10.0, which accepted errors sharing a `_tag` and told them apart by their
other fields: a client decodes a failure as the first schema that accepts it, so where one
accepted the other's values the client received the wrong error, its other fields dropped, and
Effect's `catchTag` never told them apart. Errors without a `_tag` are still accepted.

The message replaces `… error _tag "<tag>" is built in, and declared on every surface`, which an
error reusing a built-in error's `_tag` threw; a binding's message now names the action,
`ActionHttp binding of "<name>"` or `ActionRpc binding of "<name>"`.

- Migrate: reuse one schema value where two declare one error; merge variants into one schema
  whose fields tell them apart, such as
  `Schema.TaggedStruct("Validation", { field: Schema.Literals(["email", "name"]) })` or one with a
  tagged `reason`; or rename one of the tags. Update code matching the old message.

**A message the library throws says its fix.** Every message a consumer can trigger names its
fix, most in parentheses after what failed. Changed: an invalid action name or `readOnly`, an
`authorize` that is not a function or given to a public-only target, missing or unknown
handlers, a duplicate action, flag, command, positional argument or middleware, an action listed
but not held, an implementation none of whose actions is bound, an implementation that is a
copy, a protected action without its descriptor, an MCP tool whose input is not one object,
whose image is misplaced or whose name a native feature claims, a CLI without `Stdio`, a
client method for an action a hand-spread binding's group lacks, and
`Authentication.layer`'s and `refusalResponse`'s refusals of a resource, a scope, a fragment or
an error. Some messages changed before the fix: `Missing authorize: not a
function (…)` replaces `Missing authorize: pass an authorization function, or Action.allowAll`,
and the copied implementation's no longer asks `is effect-actions installed twice?`.

- Migrate: update code matching an old message. A one-character alias in a duplicate-flag
  message is now shown as `-n`; every other message keeps its start.

### Additions

**A remote command's `client` needs only the methods of the actions it derives.** With
`actions`, `ActionCli.remote`'s `client` holds those actions' methods, and `remoteCommand`'s its
one action's, where both held every action of the binding. A CLI splitting one binding into
groups of commands no longer needs a binding per group for a client of its own. Without
`actions`, `client` still holds every action; methods beyond the needed ones are allowed, as
before.

**A derived command takes a `description`** in the options of `command`, `remoteCommand`, and
`make`'s and `remote`'s `commands`, shown in `--help` instead of the action's description, which
HTTP, MCP and RPC keep.

### Other changes

- `ActionToolkit.Options.needsApproval` may return an Effect that fails, and a call whose
  policy fails asks for approval, where Effect's own default ran it unapproved; a defect ends
  the turn, as Effect's own does.
- `ActionCli.Calling`, the `client` option `remote` and `remoteCommand` take, is exported.
- A `protectedResource.resource` that is not an absolute URL, such as `/mcp`, is refused at
  `Authentication.layer` and `refusalResponse` with the library's own message naming the fix,
  where the platform's `TypeError: Invalid URL` was thrown. The message for a descriptor given
  where its provider was built from another now reads
  `Authentication "<name>": the descriptor named here is not the one its provider was built from (build both from one descriptor)`,
  holding for an MCP endpoint and `protect` too.
- The docs follow one model, that of `docs/Action.md`: a page is the concept, the one way to do
  each task, whole example files as its snippets and links; the rule of each option is in its
  JSDoc, and what a call answers on each surface is in the JSDoc of the declaration that
  answers it, as `**Gotchas**`: `ActionHttp.layer`, `ActionMcp.layerHttp` and `runStdio`,
  `ActionRpc.layer`, `ActionToolkit.make`, `ActionCli.command`, each typed client, and
  `Action.Unauthenticated` and `Action.Forbidden` for a refusal. All of it ships in `dist/`:
  grep the symbol.
  `docs/Action-in-process.md` is folded into `docs/Action.md`; `docs/guarantees.md` and
  `docs/CONTEXT.md` are gone, each term defined where it is first used. The option tables are
  gone, and the `*-failures.md` pages hold only messages the library does not own, compiler
  diagnostics and Effect's among them,
  one line each. `docs/setup.md`'s `tsconfig.json` adds `"types": ["node"]`, and its install
  table `@types/node`, which the examples need.
- `Action.make` takes a helper's type parameter standing for `caller` or `error`: a
  `Context.Reference` is refused by `caller`'s own type, not by a rule over the options. One
  standing for `mcp` is still refused, since the hint check cannot see through it.
- A built-in error listed in an action's `error`, a binding's or an authentication's is accepted,
  in the types and at each `make`, where it was refused: every surface declares it anyway.
- An endpoint's OpenAPI responses name an error schema once, however often the call reaches it.

## 0.18.2

Corrects documentation and comments the code had outgrown. The API and its behavior are
unchanged.

### Other changes

- An `Action.client` call that dies with a `SchemaError` holds the failure before it when the
  action's errors reject the failure, undeclared or breaking a check, and after it when they
  accept one that does not encode; `Action-failures.md` gave one order for both.
- `docs/guarantees.md` says only HTTP, MCP and RPC log a defect, and that a `requestScoped` MCP
  endpoint serves only 2026-07-28, and only `POST`. `ActionMcp.md` says the library, not the
  native server, refuses an argument the schema refuses, a JSON-RPC error to a 2025-06-18
  client; `Action.md`, that `Schema.Struct({})` refuses `undefined` as well as `null`.
- `docs/setup.md` asks for `vitest@^5` where it named a patch release.
- `ActionHttp.client`'s JSDoc names the binding's errors and a protected action's verifier
  errors among a call's failures; `Authentication`'s, that an API key's 401 names no scheme;
  `ActionCli.make`'s points to `assistant`'s commands, which call it.
- The examples' `stdio.ts` comments give the full-path `claude mcp add` line `mcp-tools`' README
  explains. The `kitchen-sink` README shows `remote`'s `client` and names `openApprovals`, and
  it and `notes-service`'s count two commands written by hand.

## 0.18.1

Built and tested against `effect` and `@effect/platform-node` `4.0.5`. The `effect` peer stays
`~4.0.4`: a later Effect patch raises it only when the package needs that patch.

## 0.18.0

### Breaking changes

**`ActionCli.remote` and `remoteCommand` take the client their commands call**, as `client`: an
Effect of the binding's client, such as `ActionHttp.client(Http, { baseUrl })`, run each time a
command runs. A command of your own calls through the same value, `yield* api`, where it rebuilt
the client before. What the Effect fails with, a `ConfigError` reading the connection for one, is
each command's failure, printed as `Tag: message`, or a `CliError.UserError` as its `userMessage`
alone, as in a command of your own; what the client's methods fail with and require is each
command's too. `RemoteOptions` and `RemoteCommandOptions` are removed: the options
are `Options` and `CommandOptions`, beside `client`. This replaces providing a configured
`HttpClient` with `Command.provideEffect(HttpClient.HttpClient, …)`, which still works but types
no failure of a request beyond an `HttpClientError`.

- Migrate: `client: { baseUrl, transformClient }` is
  `client: ActionHttp.client(Http, { baseUrl, transformClient })`. A connection read from
  `Config` is `client: Effect.gen(function* () { …; return yield* ActionHttp.client(Http, …) })`,
  as `notes-service/src/commands.ts` does; give a command of your own the same Effect. Options
  annotated `RemoteOptions<A>` are `Options<A>`, and take `client` beside them in the call.

**A command `ActionCli.make` or `command` derives passes an Effect CLI error through**, as one of
your own does through `toUserError`: a builder failing with `CliError.UserError` prints its
`userMessage` alone, and the command fails with that error as it is, not with a `UserError` whose
`reason` it is.

- Migrate: match such a failure as Effect CLI's `UserError` itself, where code read `reason`.

**A helper typed `Parameters<typeof ActionHttp.client>[1]` sees `Options<unknown, unknown>`**, the
options of the new overload below, and no plain transform fits it.

- Migrate: type it `ActionHttp.ClientOptions`, or `ActionHttp.ClientOptions<E, R>`.

### Additions

**A client's `transformClient` may fail and require services of its own**, as Effect's
`HttpApiClient.makeWith` takes a client: `ActionHttp.client`, `ActionHttp.fetchClient` and
`ActionMcp.client`. A credential read or refreshed per request,
`(client) => HttpClient.mapRequestEffect(client, authorize)`, then fails each call with
`authorize`'s own errors, as they are, and each call requires its services, provided on the call
for a `fetchClient`'s. A plain transform keeps the types it had.

- Migrate: a transform that wrapped such a failure in an `HttpClientError` to fit the old type
  fails with the error itself.

## 0.17.0

### Breaking changes

**Action spans measure shared dispatch, including authorization and cleanup.** This reverses
the handler-only boundary: authorizer spans are now children of the action span, and their logs
carry the action attributes. Refusals, validated failures and cleanup defects appear in the
action span's final exit. Span names and attributes stay the same.

- Migrate: adjust dashboards that treated action duration as handler time. Add a named span
  inside the handler when that measurement is needed separately. No consumer API changes.

**`ActionMcp.McpCallError` says why in a tagged `reason`, not only in its message.** It holds
the `tool` called and one of `StatusError` (`status`, `body`), `ProtocolError` (`code`,
`message`), `NoReply` (`body`), `UndeclaredError` (`text`) or `NoStructuredContent` (`body`), as
Effect's `HttpClientError` holds its reason. Its `message` keeps
the sentence it had, now a declared field built from `tool` and `reason`.

- Migrate: branch on `error.reason._tag`, or recover one reason with
  `Effect.catchReason("McpCallError", "StatusError", ({ status }) => ...)`, where code matched
  the message text.

### Examples

- **Customize generated tools with native Effect APIs.** The assistant uses `Tool.Title` and
  `Toolkit.merge` to label approval requests, reusing the original handler layer. The recipe in
  `ActionToolkit.md` covers customization and adding other native tools. No library API changes.
- **Adapters live in `platform/`.** A Layer that reaches a technology is no longer a static of
  its domain's service: mcp-tools' `PrintFarm.layer` is `printFarm` in
  `src/platform/print-farm.ts`, beside the fake farm, and assistant's `TaskStore.layerFile` is
  `tasksFile` in `src/platform/tasks-file.ts`, built with `TaskStore.make`. The domain keeps the
  service, its constructor and its in-memory Layer. No library API changes.
- **`notes-service` demonstrates optional write deduplication.** Pass `requestId` to `createNote`
  (CLI: `--request-id`) and reuse it with the same content to replay the original result;
  changed content fails with `RequestConflict`. Calls without a key create a new note each time.
  `importNotes` shares a content schema instead of `CreateNote.input`, replacing 0.15.0's schema
  reuse so imports exclude request metadata. No library API changes.

## 0.16.0

### Breaking changes

**An MCP endpoint over HTTP serving actions alone has no 2026-07-28 subscriptions**:
`ActionMcp.layerHttp`'s `allowSubscriptions` defaults to whether `features` are given, where it
was Effect's `true`. Discovery advertises `listChanged: false` and `subscriptions/listen` answers
Method not found, where a subscriber held a stream open for changes such an endpoint makes only
where a handler changes the server: it registers its actions' tools once, before any client
connects, and serves no resource. An endpoint with `features` keeps Effect's subscriptions,
resource updates included. A 2025 revision's session is unchanged, as Effect applies the option
to 2026-07-28 alone, and so is `runStdio`, as `McpServer.layerStdio` has no such option.

- Migrate: drop `allowSubscriptions: false` from an endpoint without `features`, where it is now
  the default; keep it on one with `features` to keep subscriptions off. Pass `true` where a
  handler changes the server through `McpServer.McpServer`.

## 0.15.0

### Breaking changes

**The MCP client and request builder move from `Testing` to `ActionMcp`**, beside the server
they call, as `ActionHttp.client` sits beside `ActionHttp.layer`. `Testing` keeps `layer`, the
in-memory `HttpClient` both clients run on. Nothing else changes: the same arguments, options,
decoding and failures.

- Migrate: import `@gjermundgaraba/effect-actions/ActionMcp` and rename.

| Before                                       | After                                       |
| -------------------------------------------- | ------------------------------------------- |
| `Testing.mcpClient(actions, options?)`       | `ActionMcp.client(actions, options?)`       |
| `Testing.mcpRequest(method, params?, opts?)` | `ActionMcp.request(method, params?, opts?)` |
| `Testing.McpCallError`                       | `ActionMcp.McpCallError`                    |
| `Testing.McpClient<Actions>`                 | `ActionMcp.Client<Actions>`                 |
| `Testing.McpClientOptions`                   | `ActionMcp.ClientOptions`                   |
| `Testing.McpRequestOptions`                  | `ActionMcp.RequestOptions`                  |
| `Testing.McpParams`                          | `ActionMcp.Params`                          |

**A failure an action's errors reject is its call's defect on every surface**: one it does not
declare, which a cast or plain JavaScript lets through, or one breaking a check of its schema,
which the types let through, such as `Infinity` in a struct error's `Schema.Finite` field. The
defect carries the failure, with its trace, and the `SchemaError` saying why. A class error's
checks are not rerun, so one built with `disableChecks` still fails to encode, as before. HTTP,
MCP and RPC answer it as before, and their logs and error reporters now name
the failure, where HTTP's and MCP's named only the error encoding it. A Toolkit call dies with it,
where it failed with an `AiError`, `Failed to encode result for tool …`, and a command dies with
it, where it failed with a `UserError` printed as its tag and message.

- Migrate: declare the error on the action, or fix the value. A host matching the `AiError` or the `UserError` for
  such a failure matches the defect instead.

### Additions

- **`ActionMcp.layerHttp(..., { requestScoped: true })` serves MCP on a host that runs nothing
  between requests, such as Cloudflare Workers.** It uses Effect 4.0.4's
  `McpServer.layerHttpRequestScoped`: each request runs on a server of its own, which ends with
  its response, where the endpoint ran one server for every request, which such a host cannot
  keep. The endpoint speaks MCP 2026-07-28 alone and keeps no session, so a client that opens
  with `initialize`, such as Codex, is refused there: serve it from a long-lived host, as before.
  Authentication, the mixed endpoint's gate, progress notifications and `ActionMcp.client` work
  as on a long-lived endpoint, and native `features` but for list-change notifications and
  `McpServer.elicit`; `allowSubscriptions` is ignored there.
  `notes-service` adds `src/worker.ts`, its routes as a `fetch` handler
  ([ActionMcp.md](docs/ActionMcp.md#serve-tools-over-http)).

### Other changes

- **`ActionMcp.client` takes the endpoint's `authentication`**, as `layerHttp` does: an error its
  verifier declares, the endpoint's HTTP answer for a protected tool, is then its decoded value and
  in the method's type, as over `ActionHttp.client`, where it was an `McpCallError`.
- **A mixed MCP endpoint lets a client that base64-encodes a public tool's `Mcp-Name`**
  (`=?base64?…?=`) call it signed out, as Effect routes that name. This reverses 0.10.0's "a
  Base64-encoded tool name names no public tool, and authenticates", which answered such a call 401.
- An MCP tool whose handler fails with an undeclared `AiError`, such as one a model call leaks, is
  answered with the internal error text and reported, as every other undeclared failure is; it
  was sent as the tool's error result.
- An `ErrorReporter` gets an MCP tool's result or declared error that does not encode as a
  defect, its `SchemaError`, where it was an `AiError` of module `Toolkit`.
- **A command's `InvalidInput` names every field that does not decode**, as HTTP, RPC, MCP and
  `Action.client` do; it named only the first.
- A Toolkit tool carries all four MCP hint annotations, MCP's default where the action's `mcp`
  leaves one out, the values MCP's listing gives. This reverses 0.10.0's annotating only a given
  hint: the listing no longer reads the Toolkit's annotations, so both now take the hints from one
  place.
- `destructiveHint`'s JSDoc says an update of a stored flag, such as "read", stays destructive.
- The docs say a hand-written command's client already checks a file's input, so a decode of
  its own only repeats that check; that undecodable tool arguments are an `AiError`, not
  `InvalidInput`; how to name an assistant's files against TS1149; that an MCP request that
  must authenticate, or sends a token, gets 401 without a valid one before `allowedOrigins` is
  checked; and which errors protecting an action raises in its existing tests. `Testing-failures.md` says which line of a missing
  service's error to search under `exactOptionalPropertyTypes`.
- The docs' advice for decoding input of your own reports every issue, as the surfaces do; it
  reported only the first. What a refusal answers on each surface is stated once, in
  `docs/guarantees.md`, which `Forbidden`'s JSDoc now points to.
- `notes-service`'s `importNotes` takes `CreateNote.input` as each note's schema; `live-rpc`
  routes to serving the same actions as JSON and names another choice to decide when copying.

## 0.14.0

Built and tested against `effect` and `@effect/platform-node` `4.0.4`. The `effect` peer is now
`~4.0.4`.

### Breaking changes

**The `effect` peer requires Effect 4.0.4 or a later 4.0.x patch**, the release the package is
now tested against.

- Migrate: install `effect` and every `@effect/*` package at `~4.0.4`.

## 0.13.0

Built and tested against `effect` and `@effect/platform-node` `4.0.3`. The `effect` peer is now
`~4.0.3`.

### Breaking changes

**The `effect` peer requires Effect 4.0.3 or a later 4.0.x patch**, the release the package is
now tested against.

- Migrate: install `effect` and every `@effect/*` package at `~4.0.3`.

### Additions

- `ActionMcp.layerHttp` takes Effect 4.0.3's `allowSubscriptions`: `false` turns off MCP
  2026-07-28 subscriptions ([ActionMcp.md](docs/ActionMcp.md#api)).
- **`ActionToolkit.openApprovals(history)`** lists the approval requests a conversation's history
  still holds open, each an `Approval` with the call an answer would run (`approvalId`,
  `toolCallId`, `name`, `params`): those with neither an answer nor a result, the call found as
  Effect finds it. An answer recorded without a result, as a `streamText` turn that failed
  while its call ran leaves it, is not open: the next turn acts on it, and another answer would
  run the call twice. It replaces the function the kitchen-sink assistant defined, which
  applications copied, and which listed such a request again
  ([ActionToolkit.md](docs/ActionToolkit.md)).

### Other changes

- **`Testing.layer` logs the cause of a failed request on the process console, under `it.effect`
  too.** `it.effect` provides a `TestConsole`, which kept the log out of the test's output, so a
  test saw only `Decode error (500 …)`. A `Logger` provided around the layer still receives it;
  a `Console` provided around it, `it.effect`'s included, no longer does: collect the log with a
  `Logger`.
- `destructiveHint`'s JSDoc and [ActionMcp.md](docs/ActionMcp.md#describe-tools-to-a-model)
  use MCP's words: a non-destructive tool performs only additive updates. The examples' hints
  follow it: `mcp-tools`' `start_print` and `set_paused` are now destructive.
- The docs say how to read a page whose output was cut, show the `claude mcp add` and
  `codex mcp add` lines for a protected endpoint, say how to type an MCP request's `arguments`
  in a test helper, and gain failure entries for an optional `userMessage`, a module name that
  differs only in case (TS1149) and an error `toBeInstanceOf` does not narrow.
- `notes-service` adds `importNotes`, a bulk import as one action, and a `notes import` command
  that reads a file `notes export` wrote and calls it once; `export` escapes a body line that
  starts as a title would, so every note reads back as it was, up to the action's 100; a title
  is one line. The example servers read `HOST`; `live-rpc`'s `NotAuthor` no longer names the
  message's author; `mcp-tools` links [ActionMcp.md](docs/ActionMcp.md) for tools that need a
  token.

## 0.12.0

Built and tested against `effect` and `@effect/platform-node` `4.0.2`, on TypeScript 7.

### Breaking changes

**`ActionMcp.layerHttp` no longer takes Effect's `allowSessionTermination`.** It is always on: a
client may end the session it opened.

- Migrate: remove the option.

**An MCP endpoint over HTTP also speaks MCP 2025-11-25 and 2025-06-18, as stdio does.** A client
that opens with `initialize`, such as Codex, now connects, where it was refused with JSON-RPC
error `-32020`. This reverses "HTTP serves 2026-07-28 only", decided because Effect's HTTP runtime
expires no session: a hosted endpoint was out of such a host's reach, and a session holds no
identity. Each request still authenticates as its own caller; a session lasts until its client
ends it with a `DELETE` or the process stops; and on an endpoint serving a protected tool only a
signed-in caller opens one, so a client of a 2025 revision signs in for every request there, a
public tool's call included. On such an endpoint a signed-out 2026-07-28 request whose
`Mcp-Method` header names another method than its body is answered 401, where it was 400
([ActionMcp.md](docs/ActionMcp.md#serve-tools-over-http)).

- Migrate: nothing. Limit request bodies, which bounds what a session holds
  ([ActionHttp.md](docs/ActionHttp.md#serve-the-routes)).

**A builder that yields the caller no longer type-checks where a server serves it, even with the
identity provided at startup.** Among the startup requirements of `ActionHttp.layer`,
`ActionRpc.layer` and `ActionMcp.layerHttp`, the identity a builder or an Effect building the
authorizer yields is replaced by a type whose one property is named by the sentence
`"A builder yields the caller, which a server has per request: yield it in a handler or an authorizer"`,
which is what the compiler now prints last wherever the routes are launched or run, in place of
`Type 'CurrentUser' is not assignable to type 'never'`. The property's type names the caller
and the actions whose builder yields it, `{ caller: CurrentUser; builderOf: "createNote" | ... }`:
the error is reported where the routes are served and run, not where the builder is. `runStdio`, `ActionToolkit`, `ActionCli`
and `Action.client`, whose host names one caller, are unchanged.

- Migrate: move the `yield*` of the identity into the handler or the authorizer.

**`Testing.mcpClient` fails an input that does not encode with `InvalidInput`, as every other
client does, instead of `SchemaError`.** Nothing is sent, as before.

- Migrate: match `InvalidInput` where a test caught that `SchemaError`.

**`ActionMcp.layerHttp` and `Authentication.protect` refuse a descriptor that is not their
provider's, as `ActionHttp.layer` and `ActionRpc.layer` do.** Given a descriptor built apart
from the one `Authentication.layer` took, under the same name, they die when their layer
builds, with `Authentication "<name>": the binding's descriptor is not its provider's`. They
followed the provider's scheme silently, so an endpoint declaring one cookie accepted another
([Authentication-failures.md](docs/Authentication-failures.md)).

- Migrate: build the endpoint, the protected route and the provider from one descriptor value.

### Additions

- `ActionCli.make` and `remote` take `subcommands`, commands of your own beside the derived ones,
  as Effect's `Command.withSubcommands` takes them:
  `ActionCli.remote(Http, { name: "notes", subcommands: [exportNotes] })`. Piping
  `Command.withSubcommands` onto the result replaces the derived commands, so every action had to
  be listed again as a `remoteCommand` beside one command written by hand. A name a derived
  command has throws `Duplicate command`; written in the call, or in options held with
  `satisfies`, the list adds its commands' failures and services to the aggregate's type, and
  in annotated options it adds none ([ActionCli.md](docs/ActionCli.md#add-a-command-of-your-own)).
- `ActionCli.toUserError` makes a command of your own fail as a derived command does. Given the
  binding, HTTP or RPC, or the actions the command calls and piped onto its whole Effect, a declared
  error, the binding's and its authentication's included, is printed as its JSON and a transport failure
  named with its causes, where a hand-written `CliError.UserError` printed prose and a call left
  unmapped crashed with a stack trace. An Effect CLI error passes through as it is
  ([ActionCli.md](docs/ActionCli.md#add-a-command-of-your-own)).
- A derived command's `--help` says what a flag's name and kind do not, after the field's own
  description: `Repeat for each value.` on a repeated flag, `--no-<flag> sends false.` on an
  optional boolean's switch, `Left out, it sends false.` on a required one, and `A JSON array.`
  or `A JSON object.` on a value that is one, an array of objects with its fields,
  `A JSON array of {id, approved?}.`
- A flag's help shows the field's description wherever it is annotated. One annotated before a
  check, or on the field's key with `annotateKey`, where an MCP tool's listing reads it, was
  missing from `--help`. A repeated flag with no
  description of its own shows its element's.
- The compiler says what is missing where a protected action is implemented without
  `authorize`: the message ends `is not assignable to type '"A protected action takes
  { authorize }: your rule, or Action.allowAll"'`, where it ended `'typeof CurrentUser' is not
  assignable to type 'unique symbol'`. The constraint named `ProtectedActionsTakeAuthorize`,
  which the error showed for one action and not for a list, is gone.
- An error at `Action.implement` no longer starts `No overload matches this call. The last
  overload gave the following error.`: its two signatures take three arguments and two, so a call
  is checked against one, and the cause is two lines nearer the top. This replaces the third
  overload, which repeated the first because TypeScript reports against the last. A public
  target still takes `{}`, `undefined` or forwarded options as its third argument. `typeof
  Action.implement` reads as the two-argument signature, so `Parameters<typeof Action.implement>[2]`
  no longer compiles.
- The compiler names an undeclared error where a handler fails with one: the message ends
  `Property '"~declared in the action's error, or built in"' is missing in type 'NoteTooLong'`,
  where it ended `Property '"~builtIn"' is missing`.
- `ActionCli.command` and `remoteCommand` take `stdin`, a required field of the input read from
  standard input instead of a flag, such as a secret a flag would leave in the process list and
  the shell's history: `ActionCli.remoteCommand(Http, PutSecret, { stdin: "value" })` reads
  `op read op://vault/token | cli put-secret --name gh`. Its text is all of stdin without the
  line endings that end it: a string's value as it is, any other field's JSON it accepts, such as
  `["a","b"]` for an array, or else the text, which the action's schema decodes; a terminal is
  refused as `InvalidInput`. The field has no flag, and help says it is
  read from stdin. `make`'s and `remote`'s `commands` take it too
  ([ActionCli.md](docs/ActionCli.md)).
- `ActionRpc`, a new module, serves actions as Effect RPC on Effect's own `RpcServer`. A
  browser-safe binding, `ActionRpc.make(actions, { authentication, error })`, holds a native
  `RpcGroup`, `Rpc.group`, one rpc per action; `ActionRpc.layer(Rpc, implementations, { middleware })`
  serves it over the protocol speaking JSON the host provides; and
  `ActionRpc.client(Rpc)` has the methods of `ActionHttp.client` and `Action.client`. A protected
  rpc authenticates each message with the descriptor's provider, so one WebSocket carries several
  callers, then runs the layer's native `RpcMiddleware`, decodes its input, a typed `InvalidInput`
  when it does not, and runs the authorizer. Refusals are the typed `Unauthenticated` and
  `Forbidden`, with no challenge or step-up. A defect, a middleware that throws included, is
  logged and answered as that request's `Internal server error` alone, reported once with its
  cause to the call's `ErrorReporter`s; a declared failure is not reported. Request services come from the layer's `middleware` or
  router middleware, never startup. Public and protected actions are served over any protocol,
  a socket server and stdio included; `layer` refuses to build under a protocol
  that does not speak JSON, such as schema-binary's. This
  changes the package's stated scope, which said HTTP "is not Effect RPC"
  ([ActionRpc.md](docs/ActionRpc.md)).

  ```ts
  export const Rpc = ActionRpc.make([Status, GetUser], { authentication: Login });

  const rpc = ActionRpc.layer(Rpc, [status, userActions]).pipe(
    Layer.provide(RpcServer.layerProtocolWebsocket({ path: "/rpc" })),
    Layer.provide(RpcSerialization.layerJson),
    Layer.provide(authenticate),
  );
  ```

### Other changes

- `Testing.layer` logs, as an error, the cause of a defect, of a result that does not encode,
  or of a failure a route of your own leaves unhandled, and nothing for any other request. An
  empty 500 in a test showed its cause nowhere: a server's request logger writes it, and a test
  runs none ([Testing-failures.md](docs/Testing-failures.md)).
- A command derived over HTTP (`ActionCli.remote`, `remoteCommand`) prints an error the
  binding's authentication declares as its JSON, as it prints every other declared error. It
  printed the error's name alone.
- A command reading a field from stdin is listed by its action's description alone in its
  parent's `--help`; the "Reads <field> from stdin" line stays in the command's own help
  ([ActionCli.md](docs/ActionCli.md)).
- `Authentication.layer` requires the `HttpRouter` only when it publishes a
  `protectedResource`, so the provider serves an RPC server over a socket or stdio too
  ([Authentication.md](docs/Authentication.md)).
- A timer of the stderr console that `runStdio` and a CLI command give their program, started
  again while it runs, keeps its first start, as Node's does; it restarted
  ([ActionMcp.md](docs/ActionMcp.md)).
- [ActionHttp.md](docs/ActionHttp.md#serve-the-routes) says that an `ErrorReporter` is given a
  declared failure over HTTP, which Effect's `HttpApi` reports, and not over MCP or RPC, and how
  to mark an error class as unreported.
- The package ships `examples/`: six complete applications, each with its own tests, laid out
  by domain, from `quickstart` to `kitchen-sink`, which indexes every export and option to a
  file. They replace the single-file examples, which were fragments of one demo application
  ([examples/README.md](examples/README.md)).
- The docs are organized by task and link to example files instead of embedding them: a page
  per module with its API table, its failure modes beside it on `<Module>-failures.md`, and no
  page over 16 KB, which a coding agent's tool reads whole. `docs/guarantees.md` is the wire
  behavior of every surface in one table, and the library's scope; its lifetime and
  authorization rules moved to [Action.md](docs/Action.md) and
  [Authentication.md](docs/Authentication.md). Section anchors changed
  ([docs/README.md](docs/README.md)). [setup.md](docs/setup.md#install) has a `tsconfig.json` to
  copy.
- Each module's main export names its page and an example in its JSDoc, for a reader who opens
  a declaration before the README.
- The agent skill also installs as a Claude Code plugin and a Codex plugin, from this
  repository's marketplace, `effect-actions@effect-actions-marketplace`; it follows the main
  branch, as `npx skills add` does ([README.md](README.md#for-agents)). Its links to examples
  are paths in a project that installs the package, which an agent reads without a network.
- `package.json` names `docs` and `examples` under `directories`.

## 0.11.0

Built and tested against `effect` and `@effect/platform-node` `4.0.2`. The `effect` peer is now
`~4.0.2`.

### Breaking changes

**The `effect` peer requires Effect 4.0.2 or a later 4.0.x patch.** The peer now always starts at
the release the package is tested against.

- Migrate: install `effect` and every `@effect/*` package at `~4.0.2`.

**`ActionMcp.runStdio` answers the calls in flight when the host closes stdin, instead of
interrupting them.** This reverses 0.10.0's rule that closing stdin interrupts every call in
flight: Effect 4.0.1's native stdio server (Effect #8714) drains them, and the surfaces build on
Effect's servers rather than adding protocol machinery of their own. `runStdio` succeeds once every
answer is written, so a script piping requests may close stdin as soon as it has written them.

- Migrate: a call that never completes now keeps the subprocess running until a signal
  interrupts it. MCP hosts send `SIGTERM` when a server does not exit in time; bound long
  handlers with a timeout if the process must end on stdin alone.

**A result that does not encode over HTTP is Effect's own schema failure, not a defect.** It is
still an empty 500, and `ErrorReporter`s now receive the `HttpApiSchemaError`, with the schema's
message as its cause, once.

### Additions

- `Action.Image`, a media field, `{ data: Uint8Array, mimeType: string }`, lets an action return an
  image a model reads: a top-level field of a struct success, optional or an array, or the whole
  success or an array of it. An MCP tool lifts each into an `image` block after its one text block,
  in field order, tagged with its field in `_meta` (`"effect-actions/field"`), and sends the rest as
  any success, its `structuredContent`, `outputSchema` and JSON text; a success whose every field is
  media sends its blocks alone. A tool without media answers as before. An image an MCP tool cannot
  lift, nested, in a union or a record, in an optional array field, in a class or an encoded struct,
  given an encoding of its own, in the input or in an error, is refused when `layerHttp` or
  `runStdio` is called, naming the actions: `MCP media must be the success or an array of it, or a
  top-level field of a struct success, one, optional or a required array: <name>, ...`. Every other
  surface sends it as JSON, the bytes in base64, which OpenAPI lists as `format: byte`; a Toolkit
  gives a model that text, so leave such an action out of its `actions`. `Testing.mcpClient`
  reassembles the success from the structured content and the blocks. A tool returning an image was
  a native feature, with no contract, authorizer, other surface or `Testing.mcpClient` method; it is
  now an action ([ActionMcp.md](docs/ActionMcp.md#media)).

  ```ts
  const GetScreenImage = Action.make("get_screen_image", {
    description: "Fetch the rendered image for a listed screen.",
    input: { screen_id: Schema.Int },
    success: { screen: Screen, image: Action.Image },
    readOnly: true,
    caller: Action.Anyone,
  });
  ```

### Other changes

- Effect 4.0.2's HTTP tracing follows OpenTelemetry conventions: the server span is named for the
  method (`POST`, was `http.server POST`), a 4xx response no longer fails it, and headers are
  recorded only through `HttpMiddleware.TracerHeaderFilter`. Update dashboards and alerts that
  match the old names or statuses.

## 0.10.0

One contract, one implementation, one rule for who may call. `ActionGroup` is gone: a contract
states who may call it, `caller: Action.Anyone` or the identity a caller must have, and every
surface enforces it; `Action.implement` binds handlers to actions, behind the `authorize` an
implementation of protected actions states, on every surface. Authentication is a named,
browser-safe descriptor the binding names and a server-only verifier, enforced and documented as
native endpoint security, before any body is read. HTTP binds a flat list of actions, and one layer
serves the public and the protected ones; one MCP endpoint serves signed-out and signed-in callers.
Every client calls an action with its input, and `Action.client` calls implementations in process,
which is how their behavior is tested. Every endpoint and tool declares the built-in `InvalidInput`
(400), `Unauthenticated` (401) and `Forbidden` (403). A builder runs once per layer graph, each call
has a scope of its own, and a request's own values win over startup ones. CLI flags come from each
action's input, and a command runs on Effect's own `NodeRuntime.runMain`, printing a failure on
stderr as the JSON HTTP sends. The client modules merge into `ActionHttp` and `ActionCli`, clients
and `Testing` are Effect-only, and `ActionCatalog` and `TestingClient` are removed. `access` becomes
`readOnly`, `mcp` takes MCP's own hint names, and stdio also serves 2025-11-25 and 2025-06-18, so
Claude Code and Codex connect. The docs say where builders and your own services are built.

Built and tested against `effect` and `@effect/platform-node` `4.0.0`. The `effect` peer narrows
to `~4.0.0`, Effect's 4.0.x patches: the modules every surface builds on are unstable in Effect,
so a minor release may change them, and a later minor is admitted once the package is tested
against it: install `effect` and every `@effect/*` package at 4.0.x. TypeScript 7 or newer is
supported; earlier versions are not.
0.9.0 kept 0.8.0's API and behavior, so these notes compare with 0.8.0.

### Breaking changes

```ts
// 0.8.0
const Users = ActionGroup.make({ name: "users" }, GetUser, RenameUser);
const users = Users.implement(build);
const Http = ActionHttp.make({ apiPath: "/api", errors }, Users);
Http.layer([users], { before: authorize });
const ReadPage = Action.make("readPage", { ..., mcp: { name: "read_page", text: "markdown" } });
const pages = ActionGroup.make({ name: "pages" }, ReadPage).implement({ readPage: read });
ActionMcp.layerHttp([users, pages], { name, version, path: "/mcp", errors, before: authorize });

// 0.10.0
const GetUser = Action.make("getUser", { ..., readOnly: true, caller: CurrentActor });
const users = Action.implement([GetUser, RenameUser], build, { authorize });
const Login = Authentication.make("app.Login", CurrentActor);
const Http = ActionHttp.make([GetUser, RenameUser], { authentication: Login });
const authenticate = Authentication.layer(Login, verify, { protectedResource });
ActionHttp.layer(Http, users).pipe(Layer.provide(authenticate));
const ReadPage = Action.make("readPage", { ..., caller: CurrentActor });
const pages = Action.implement(ReadPage, read, { authorize });
ActionMcp.layerHttp([users, pages], { name, version, authentication: Login }).pipe(
  Layer.provide(authenticate),
);
```

Each area below lists what is renamed or removed, then what changes without a rename.

#### Contracts

| 0.8.0                                                                     | 0.10.0                                                                                                                                                                                                                                                                              |
| ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `access: "read"`, `access: "write"`, `action.access`, `Action.Access`     | `readOnly: true`, `readOnly: false`, `action.readOnly`, a boolean kept as its literal; the span and log attribute `action.access` becomes `action.read_only`, a boolean                                                                                                             |
| `mcp.destructive`, `mcp.idempotent`, `mcp.openWorld`                      | `mcp.destructiveHint`, `mcp.idempotentHint`, `mcp.openWorldHint`: MCP's own names, each left out MCP's default, but a read-only action's `destructiveHint`, which is `false`                                                                                                        |
| `action.mcp`, `Action.McpOptions`                                         | `action.mcp`, the options as given, without defaults, `Action.Mcp`                                                                                                                                                                                                                  |
| `mcp.name`                                                                | The action's name, which is the tool's: `get_user` becomes the tool `getUser`, so update hosts' allowed tools and prompts. To keep a tool's name, give it to the action, which also names its route, client method and command                                                      |
| `mcp.readOnly`                                                            | The contract's `readOnly`: a tool is read-only exactly when its action is                                                                                                                                                                                                           |
| `mcp: { text: "markdown" }`                                               | Removed: the tool sends the whole success as structured content, plus its JSON as text                                                                                                                                                                                              |
| `mcp: false`                                                              | Leave the action out of the `actions` option of `ActionMcp.layerHttp`, `runStdio` and `ActionToolkit.make`: list the actions that are tools beside the contracts, `actions: Tools`, and an action added later is no tool until it is listed ([Action.md](docs/Action.md#contracts)) |
| `errors: [UserNotFound]`, `action.errors`                                 | `error: UserNotFound` or `error: [UserNotFound, Conflict]`, as `HttpApiEndpoint` takes it; `action.error`, always a list                                                                                                                                                            |
| `Action.Codec`                                                            | `Action.Any["input"]`                                                                                                                                                                                                                                                               |
| `Action.Action`'s `Mcp` type parameter, `Action.Options`' type parameters | `Action.Action<Name, Input, Success, Errors, ReadOnly, Caller>`; `Action.Options` has none                                                                                                                                                                                          |

- Every contract states who may call it, `caller`: `Action.Anyone`, or the identity service a caller
  must have, such as `caller: CurrentActor`. Without it `make` does not compile, and from plain
  JavaScript throws `Missing caller: declare Action.Anyone or an identity service key`. 0.8.0 left
  this to whichever layers the host wrapped in authentication. Every surface now enforces it,
  whatever the handler reads: remotely through the binding's or endpoint's authentication
  descriptor, locally by owing the identity per call. Give `caller: Action.Anyone` to an action
  0.8.0 served without authentication or a hook, and the identity its hook or handler read to every
  other. The module declaring the identity, a `Context.Service`, stays free of server code:
  contracts import it.
- `Action.make` throws `Invalid action name: <name>` for a name over 128 characters, which 0.8.0
  refused only as a tool name: shorten it. Its types refuse an unknown `mcp` key, such as a
  misspelling or `readOnlyHint`, and options typed by a helper's type parameter: type that
  parameter `Action.Mcp`. A `readOnly` that is not a boolean throws `Invalid readOnly: <value>`.

#### Implementations and authorization

| 0.8.0                                                                                        | 0.10.0                                                                                                                                                                                                |
| -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ActionGroup.make(...)`, `Group.implement(build)`                                            | `Action.implement(actions, build, { authorize })`, `{ authorize }` only for protected actions                                                                                                         |
| `ActionGroup.Implementation`; `Group`, `Any` and `Options`                                   | `Action.Implementation`, inferred: a helper takes implementations as a type parameter ([Action.md](docs/Action.md#rules)), and a package's own interface writes one out; a group is a list of actions |
| `ActionGroup.contracts(...groups)`, `Contracts`                                              | `Action.byName(actions)`, the list keyed by name, each its exact contract; the list itself is the actions, or a binding's `Http.actions`                                                              |
| `app.group`                                                                                  | `app.actions`, its exact contracts                                                                                                                                                                    |
| `app.build`                                                                                  | `Action.client(app)`, then `client.<action>(input)`: its handlers behind its authorization, in process, the methods `ActionHttp.client` has; a surface's own behavior under `Testing.layer`           |
| A group's `errors`                                                                           | One array spread into each action's `error`; `ActionHttp.make(actions, { error })` for router middleware's; authentication's refusals are built in                                                    |
| A group's `schemaError`, `SchemaErrorPolicy`, `SchemaErrorAnswer`                            | Nothing: input that does not decode is the built-in `Action.InvalidInput`, and a success that does not encode is a defect, an empty 500                                                               |
| `before` of `Http.layer`, `ActionMcp`, `ActionToolkit.make`, `ActionCli.command` and `group` | `Action.implement(actions, handlers, { authorize })`, for an implementation of protected actions                                                                                                      |
| A hook failing with the surface's `errors`; `errors` of `ActionMcp` and `ActionToolkit`      | An authorizer failing with an `Action.Refusal` only; a limit is the handler's, failing with an error its action declares                                                                              |
| `before`'s `action`, an `Action.Any`                                                         | `authorize`'s `action`, typed as the implementation's own actions, in a built authorizer too                                                                                                          |
| Span `<group>.<action>`, attribute and log annotation `action.group`                         | Span `<action>`                                                                                                                                                                                       |

- An implementation of protected actions states who of the authenticated callers may call:
  `{ authorize }` is required, and `Action.allowAll` lets every authenticated caller call. An
  implementation of public actions alone takes none. In 0.8.0 `before` was an option of
  `Http.layer`, `ActionMcp.layerHttp` and `layerStdio`, `ActionToolkit.make`,
  `ActionCli.command` and `ActionCli.group`, and leaving it out meant no authorization. Pass it
  to `implement` instead; where 0.8.0 passed none, make the contract public, or pass
  `{ authorize: Action.allowAll }`. Where it guarded one surface and not another, decide per
  action: the contract is public, or the caller of the unguarded surface is a trusted identity
  the host supplies there, which the same `authorize` admits
  ([ActionCli.md](docs/ActionCli.md#trusted-callers)). Without `authorize`, `implement` of a
  protected action does not compile, naming `ProtectedActionsTakeAuthorize`, and from plain
  JavaScript it throws `Protected actions require authorize, or Action.allowAll`. `undefined`
  is not an authorizer: `before: enabled ? authorize : undefined` becomes
  `{ authorize: enabled ? authorize : Action.allowAll }`.
- `authorize` runs only for protected actions, after authentication and input decoding, and fails
  only with a refusal. A limit is the handler's: the action declares its error in `error`, so
  every surface declares it and every client decodes it, the builder yields the limiter, a startup
  service every surface of the layer graph shares, and the handler fails with the error before its
  work ([Action.md](docs/Action.md#implementations)). 0.8.0's hook failed with its surface's
  `errors`, which that surface alone declared, and a CLI's with any error: move a limit into the
  handlers of the actions it applies to, declaring its error on each, or keep a limit applied
  before decoding in HTTP middleware, router middleware or the layer's own, with
  `ActionHttp.make`'s `error`.
- One action takes its handler, and a builder for it returns the handler, not a record: a
  one-action group's `.implement({ greet: handler })` becomes
  `Action.implement(Greet, handler)`, with `{ authorize }` for a protected action. A list
  takes a record keyed by action name, as a group did.
- A record has exactly one handler per action: an extra key is a compile error, which 0.8.0
  ignored. `implement` throws `Missing handlers: <names>` or `Unknown handlers: <keys>`; a
  builder's record is checked when its layer builds.
- Within one layer graph a builder runs once, however many surfaces serve its implementation.
  This reverses 0.8.0's "An implementation served by two adapters is built twice", once per
  adapter layer: a builder is a memoized layer, so what it acquires, such as a connection
  pool, serves every surface of the graph, as a layer's services do. `HttpRouter.serve` and
  `Testing.layer` build their routes in a graph of their own, which reuses what the graph
  around them has built, so one rule places builders and your own services alike: with one
  server, put everything the process runs, a job or an agent beside the routes included, in
  the layer it serves; otherwise provide `Action.layer(implementations)` and the services they
  share above the server and its siblings. `HttpRouter.provideRequest` also builds the layer it
  provides in a graph of its own, so a model loop in a route takes its toolkit from its
  implementation's builder ([ActionToolkit.md](docs/ActionToolkit.md#rules)). To give an HTTP
  or MCP surface a build and startup services of its own, as 0.8.0's adapter layers had, wrap
  it in `Layer.fresh`, and provide what the surfaces share, authentication included, outside
  it. `ActionCli` still builds per invocation
  ([dependency lifetimes](docs/guarantees.md#dependency-lifetimes)).
- A builder's startup services are one union, `A | B` as written, so providing them in two
  `Layer.provide` calls, one per service, discharges both. 0.8.0 typed them `NoInfer<A | B>`,
  which stayed owed after both calls and showed in every hover.
- Each call has a scope of its own, on every surface: what an authorizer or a handler
  acquires is released when the call ends, the handler's first, and a fiber it forks with
  `Effect.forkScoped` is interrupted. In 0.8.0 a Toolkit call made with `tools.handle`, or
  approved through `LanguageModel`, held it until its caller's scope closed, so with a pooled
  connection per call, a third call on a pool of two waited forever. Over HTTP, a handler's
  finalizers now run before the route middleware around it resumes, and before the success
  is encoded, rather than when the request's scope closes. A resource that must outlive a
  call belongs to the builder, or to a service the host provides around its calls. `Scope`
  is never a request-time requirement: `runStdio`, a Toolkit tool, `tools.handle` and
  `LanguageModel.generateText` need no `Effect.scoped` for a handler that acquires; drop one
  added only for the types.
- `make` refuses an `error` entry encoding with a built-in `_tag`, behind `Schema.suspend`
  or among a union of `_tag` literals or an enum's values too. So does `ActionHttp.make` for
  such an entry in a binding's `error`, the built-in itself included: it throws
  `ActionHttp binding: error _tag "Unauthenticated" is built in, and declared on every surface`
  though `make`'s types accept it. Drop the `Unauthenticated` and `Forbidden` 0.8.0 declared in
  `ActionHttp.make`'s `error` for the authentication's 401 and the authorizer's 403: every endpoint
  declares the built-in ones. Replace an `Unauthenticated` or `Forbidden` of your own with the
  built-in one, in authorizers and handlers too, and Effect's `HttpApiError.Forbidden` as well:
  one with the built-in's `_tag` and fields no longer compiles there, since only the built-in
  classes are built-in errors, and their codecs encode no other. 0.8.0's example's `permission`
  goes in the message. Use
  ``new Action.Forbidden({ message: `Requires ${permission}.` })``, adding `scopes` only for
  OAuth scopes.
- `Action.make` refuses an error in `error` that encodes with a built-in error's `_tag`, and
  `ActionHttp.make` one in the binding's: checked where the contract or binding is made, so a
  client of a contract no server of this package serves cannot decode a look-alike as a
  built-in error either. Errors of your own may share a `_tag`, told apart by their other
  fields as the members of any union are. A top-level
  `Schema.suspend` in `error` is resolved then: one whose thunk reads a `const` declared later
  throws a `ReferenceError` at `make`.
- A helper passing implementations it is given beside its own takes them as one type parameter,
  `<const Apps extends ReadonlyArray<Action.AnyImplementation>>(apps: Apps)`, and spreads it,
  `[...apps, double]`, or takes one, `<App extends Action.AnyImplementation>(app: App)`, and
  lists it, `[app, double]`, as 0.8.0's `Http.layer([app, double])` took it. A value typed
  `Action.AnyImplementation` owes `unknown`, on every surface's layer.
- An implementation is served and called only by the installed copy of the package
  whose `Action.implement` made it. Another copy's surfaces, `Action.client` and `Action.layer`
  throw
  `Not an implementation made by this Action.implement: is effect-actions installed twice?`,
  a local CLI command when it runs, where 0.8.0 served it. Install one copy. Contracts and
  bindings still cross copies.

#### HTTP

| 0.8.0                                                                                  | 0.10.0                                                                                                                                                                                                                                                                   |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ActionHttp.make({ apiPath, errors }, ...groups)`                                      | `ActionHttp.make(actions, { prefix?, error?, authentication? })`: `prefix: "/api/users"` keeps `/api/users/getUser`; `authentication` is required for a protected action                                                                                                 |
| The `ActionHttp.Http` type, `Http.groups`                                              | `ActionHttp.Binding`, `Http.actions`                                                                                                                                                                                                                                     |
| `ActionHttp.Api`, `ActionHttp.LayerOptions`                                            | `typeof Http.api`; `ActionHttp.LayerOptions` is now `layer`'s `middleware`                                                                                                                                                                                               |
| `Http.layer(implementations, { before })`                                              | `ActionHttp.layer(Http, implementations, { middleware? })`, with the binding's authentication provider: `.pipe(Layer.provide(authenticate))`                                                                                                                             |
| A group left out of `ActionHttp.make`, implemented apart, to keep its actions off HTTP | The actions left out of `ActionHttp.make`, implemented with the others                                                                                                                                                                                                   |
| `Http.openApi()`                                                                       | `HttpRouter.add("GET", path, HttpServerResponse.jsonUnsafe(OpenApi.fromApi(Http.api)))`, the route 0.6.0's `openApi` replaced: `Http.api` is native                                                                                                                      |
| `ActionCatalog`                                                                        | `OpenApi.fromApi(ActionHttp.make(actions).api)` of the actions to describe, offline. A binding no layer serves may hold actions HTTP leaves out, such as a tool for agents, which `Http.api` omits. Or use an MCP endpoint's `tools/list`. Hints are each action's `mcp` |
| `HttpApiClient.make(Http.api)`'s `client.users.getUser({ payload })`                   | `ActionHttp.client(Http)`'s `client.getUser(input)`; natively `client.getUser({ payload })`                                                                                                                                                                              |
| `ActionHttpClient.promise(Http, options)`                                              | `ActionHttp.fetchClient(Http, options)`, built once, each call `Effect.runPromise`d ([ActionHttp.md](docs/ActionHttp.md#promise-callers)), the wrapper 0.6.0's `promise` replaced: clients are Effect-only                                                               |
| `ActionHttpClient.Client`, `Method`, `Options`                                         | `ActionHttp.Client`, `ActionHttp.ClientOptions`; `fetch` is `fetchClient`'s option, or `FetchHttpClient.Fetch` around `client`                                                                                                                                           |

- Routes are `POST <prefix>/<action>`, `/api` by default, with operation ID `<action>`, so
  action names are unique per binding; 0.8.0's were `POST <apiPath>/<group>/<action>`, with
  operation ID `<group>.<action>`. The OpenAPI tag is the mount path, such as `api/users`, or
  `/` at the root, rather than the group's name.
- `ActionHttp.layer` serves the binding's actions among the implementations it is given. An
  implementation's other actions, such as a tool for agents, get no route, and their names are not
  checked. This reverses 0.7.0's way to keep an action off HTTP, a group of its own that the binding
  left out, since `Http.layer` refused an implementation of any other group
  (`Implementation of group "x" is not served by this adapter`): such an action took an
  implementation of its own, its builder and hook repeated. An implementation holding none of the
  actions served is left out and not built, so one list serves each area's binding; implementations
  holding none of the binding's actions at all are refused, as the wrong ones, when `layer` is
  called: `No action of these implementations is in this HTTP binding: x`. Two implementations of
  one served action throw `Duplicate served action: <name>`, where 0.8.0 threw
  `Duplicate implementation group: <group>`; actions the binding leaves out may repeat. A layer owes
  per request its implementations' authorizers and the handlers of the actions it serves.
- One layer serves a binding's public and protected actions, from one implementation or
  several: a protected route is authenticated by the binding's descriptor, through the
  provider the layer requires, before anything reads its body, so it answers 401 before a 415
  or a 400; a public route ignores credentials. 0.8.0 authenticated whatever layer the host
  wrapped, public and protected actions in separate layers: merge them into one
  ([ActionHttp.md](docs/ActionHttp.md#rules)). A test or a raw request asserting a 415 or a 400
  on a protected route sends a token.
- The OpenAPI document states each protected operation's security requirement, from the
  descriptor's native security middleware, the one that enforces it, and a public one's
  `security: []`; 0.8.0 stated none. Its scheme is keyed by the descriptor's name as it is,
  `example.Login`, so distinct descriptors never share a key in one combined document. A name
  is an OpenAPI component key, letters, digits, `_`, `.` and `-`: `make` throws
  `Invalid authentication name` for any other, such as `example/Login`.
- Every endpoint declares its action's errors, its binding's, and the three built-in ones, and every
  tool its action's and the three. Any handler may fail with the built-in ones unlisted. Input that
  does not decode, malformed JSON included, is a 400 `InvalidInput` carrying the schema's message
  and its `issues`, each a `path` into the input and a `message`, which a handler refusing input
  that decodes may name too. `issues` is always sent, `[]` when an `InvalidInput` names none, and
  decoders and the OpenAPI document require it. An application's own error for bad input, kept for
  its structured issues, is deleted. A result that does not encode is an empty 500. 0.8.0 answered
  both with an empty 400, or with its group's `schemaError` answers. Nothing replaces `schemaError`:
  input needs no error of your own, since every surface declares `InvalidInput`, and a success that
  does not encode means the handler broke its contract after it ran, so any write it made has
  already happened, which a declared error would misreport. Defects, crashes and proxies send a 5xx
  without a declared body anyway. Delete the policy, and its `internal` error unless a handler fails
  with it.
- A declared error without an `httpApiStatus` is sent as 422, not 500; a union without one
  sends each member at its own. Annotate `{ httpApiStatus: 500 }` to keep the old status.
- `ActionHttp` answers a request without a content type with 415, as an MCP endpoint does;
  0.8.0 read it as JSON. A page on any origin can send such a body, with the caller's cookies,
  without a CORS preflight. The library's clients send `Content-Type: application/json`; a raw
  caller adds it. A route's payload is JSON whatever encoding its input is annotated with, such
  as `HttpApiSchema.asFormUrlEncoded()`, which `HttpApi` would accept as a form body, sent
  without a preflight too, and no other surface reads; the binding's client sends JSON.
- On `ActionHttp` and `ActionMcp`, a value a request gets from authentication,
  `HttpRouter.provideRequest` or other router middleware wins over one the routes were built
  with under the same tag, as on native routes and in a Toolkit call; a startup value only
  fills in one the request lacks. 0.8.0 let the startup value win: an identity provided at a
  server's root replaced the authenticated caller, and routes built inside a span parented
  their action spans to it. A protected action's identity is no longer such a value: only its
  authentication provider gives it, and nothing provided at startup or per request satisfies
  a layer serving it. A value provided around `HttpRouter.serve` or the program is the
  request's too, so it also wins over one provided to a single surface's layer, which 0.8.0
  let override it there; scope such a value with `HttpRouter.provideRequest`. Still never
  provide an identity at startup: a public handler or a route of the host's own reading it
  would serve every caller as it.
- A typed client drops an undeclared input field when it encodes, nested ones too, instead of
  failing with `SchemaError` before sending: `ActionHttp.client`, the native `HttpApiClient` on
  `Http.api`, and `Testing.mcpClient`. This reverses 0.8.0's "Typed HTTP clients fail with
  `SchemaError` on an undeclared field": TypeScript lets a wider value through, so a call the
  compiler accepted failed. The server still refuses the field from a raw caller: HTTP with a
  400 `InvalidInput` naming its path, MCP as invalid arguments. No call needs changing; to
  assert the refusal, send a raw request.
- A typed HTTP client fails input that does not encode with `InvalidInput` and its `issues`, as
  every surface answers it, and sends nothing, in place of the native `SchemaError`, which a
  caller could not tell from a success that does not decode. `SchemaError` now means only the
  latter. Match bad input as `InvalidInput`, whichever client sent it.
- A client's argument may be omitted exactly when `{}` is a valid encoded input, and then sends
  the input `{}` decodes to, so an input class whose fields are all optional, or have decoding
  defaults, may be left out; an input that decodes from fields `{}` lacks needs its argument. A
  given argument is sent as given; 0.8.0's Promise client sent `{}` for `undefined` or `null`.

#### Authentication

| 0.8.0                                                                            | 0.10.0                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Authentication.middleware(tag, authenticate).layer`                             | The descriptor `Authentication.make("app.Login", tag)`, named by the binding and every MCP endpoint serving protected actions, and its provider `Authentication.layer(Login, verify, { protectedResource })`, provided to their layers, where `verify` takes the credential Effect's native scheme decodes and may fail with a refusal or an error the descriptor declares in `error`; a session cookie, an API key or Basic is the descriptor's one scheme, `{ security: HttpApiSecurity.apiKey({ in: "cookie", key: "session" }) }` |
| `Authentication.ProtectedResourceOptions`, `BearerChallengeOptions`              | `Authentication.ProtectedResource`, `layer`'s `protectedResource`                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `Authentication.protectedResource`: its `layer`, `metadataUrl` and `challenge()` | `layer`'s `protectedResource`, which publishes discovery and names its URL in every challenge; outside the router, `Authentication.refusalResponse`                                                                                                                                                                                                                                                                                                                                                                                   |
| A 401 challenge naming a scope                                                   | `scopesRequired` in the protected resource                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| An insufficient-scope error of your own and a hand-built challenge               | `new Action.Forbidden({ message, scopes: [scope] })`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Middleware provided around a layer to authenticate it                            | The contracts' `caller` decides, and the layer requires the provider: a protected action is authenticated on every layer serving it, a public one on none                                                                                                                                                                                                                                                                                                                                                                             |
| Middleware reading the identity, after authentication                            | `ActionHttp.layer(Http, apps, { middleware: [LogCaller] })`, native `HttpApiMiddleware`; over HTTP only                                                                                                                                                                                                                                                                                                                                                                                                                               |

- A descriptor covers action endpoints alone: an `HttpRouter.add` route that sat under 0.8.0's
  middleware takes `Authentication.protect(Login)`, router middleware authenticating it with the
  same provider, `route.pipe(Layer.provide(Authentication.protect(Login).layer))`
  ([Authentication.md](docs/Authentication.md#a-route-of-your-own)).
- `make` is a browser-safe declaration: its name literal identifies the one provider that satisfies
  it, so a provider of another descriptor of the same identity does not. It names one native
  `HttpApiSecurity` scheme, Bearer unless `security` gives another, such as a session cookie,
  `HttpApiSecurity.apiKey({ in: "cookie", key: "session" })`, or `HttpApiSecurity.basic`; a record
  of schemes, or anything else, throws `Authentication takes one native HttpApiSecurity scheme`, and
  the types refuse it, as they do a misspelled option; its options type is
  `Authentication.Options`, and options that may leave `security` out type the credential as
  that scheme's or Bearer's. OAuth is Bearer's: only a Bearer descriptor's provider takes a
  `protectedResource` (another scheme's throws
  `A protected resource is published only for a Bearer scheme`), and only under one does a protected
  action's refusal step up; over HTTP it answers the refusal as it leaves a layer's `middleware`,
  which may recover from it or turn it into an error the binding declares, and a public route's or
  public tool's never steps up, signed in or not. Another scheme's 401 carries the challenge it has,
  an `Http` scheme naming itself, Basic `Basic realm="<descriptor name>"`, an API key none; its
  other refusals are their JSON and status over HTTP, and an `isError` tool result over MCP.
- A verifier receives the credential Effect's native scheme decodes: a `Redacted` token or key,
  or Basic's credentials, presented when its user-id or its password is non-empty, so a token
  sent as the password reaches it. An empty one, as the native decoder gives for one absent or
  malformed, never reaches it; its 401 says `A bearer token is required.`, or
  `A credential is required.` for another scheme. Its type is `Authentication.Verify`.
- A verifier fails with a refusal, or with an error its descriptor declares,
  `Authentication.make("app.Login", CurrentPrincipal, { error: ProviderUnavailable })`, one schema
  or a list, such as an issuer it cannot reach. Every protected endpoint of a binding naming the
  descriptor declares it, at its `httpApiStatus` or 422, so `ActionHttp.client` and a remote CLI
  command decode it as a typed failure, and a route, an MCP endpoint, `protect` and
  `refusalResponse` send it alike, `no-store`. A verifier no longer fails with an
  `HttpServerResponse`, which every consumer used for exactly this: the clankerauth SDK encoded its
  own 503 by hand, and every binding then declared `error: ProviderUnavailable` so clients decoded
  it, which nothing checked; and Authentication.md's "map a verifier's failure to a refusal" sent an
  outage as a 401, signing the caller out. Migrate:

  ```ts
  // before
  const Login = Authentication.make("app.Login", CurrentPrincipal);
  const Http = ActionHttp.make(actions, { authentication: Login, error: ProviderUnavailable });
  const verify = (token) =>
    Effect.mapError(check(token), (e) =>
      e instanceof ProviderUnavailable
        ? HttpServerResponse.jsonUnsafe(encode(e), { status: 503 })
        : e,
    );

  // after
  const Login = Authentication.make("app.Login", CurrentPrincipal, { error: ProviderUnavailable });
  const Http = ActionHttp.make(actions, { authentication: Login });
  const verify = check; // fails with a refusal or ProviderUnavailable
  ```

- On a protected route, or any route of an MCP endpoint naming a Bearer descriptor,
  `Unauthenticated`, or a `Forbidden` naming `scopes`, from authentication, an authorizer or a
  handler, is answered with its HTTP status, challenge and JSON, on MCP too instead of a tool
  result, as MCP authorization defines. If an MCP handler's notification has already started the
  response, a later refusal remains a tool error in that stream. Elsewhere, such a refusal is a
  declared error. A defect or an interruption after such a refusal, such as a finalizer dying, is
  the route's own, answered as one, not hidden behind the refusal's answer.
- Every 401 a Bearer descriptor covers without a challenge gets a `Bearer` one, naming
  `scopesRequired` and the metadata URL of a protected resource, and `invalid_token` when the
  request presented a bearer token, a malformed one such as `Bearer a b` included (RFC 6750
  §3.1). 0.8.0 left each 401 as the host rendered it.
- `layer`'s second argument is the verifier, or a builder of it, as `implement`'s may be: what
  a builder yields is a startup requirement of the provider's layer, built once per layer graph
  (`Authentication.layer(Login, build).pipe(Layer.provide(Verifier.layer))`), and it returns
  the verifier. What a verifier yields beyond the request is a request requirement, which
  native router middleware provided after the authentication supplies, in a `Layer.provide` of
  its own: `routes.pipe(Layer.provide(authenticate), Layer.provide(resolveTenant.layer))`. One
  array, `Layer.provide([authenticate, resolveTenant.layer])`, leaves it owed. 0.8.0's
  `authenticate` had no startup phase: every service it yielded was a request requirement.
- Nothing but the provider supplies a protected action's identity to a remote surface: an
  identity provided at startup, per request with `HttpRouter.provideRequest`, or around
  `Testing.layer`, no longer satisfies a layer serving one. A test serves its routes behind the
  real provider, or a test verifier of the same descriptor, and gives each client its token
  ([Testing.md](docs/Testing.md#signed-in-callers)).
- A protected resource's discovery is published by the provider's layer, once per layer graph,
  however many layers it is provided to, where 0.8.0's `discovery.layer` was merged beside the
  routes. It carries `Access-Control-Allow-Origin: *` and answers its own CORS preflight (204,
  allowing `GET`, `HEAD` and `OPTIONS` and the requested headers), so a browser MCP client
  reads it after a 401. Where the host's CORS middleware runs first, its policy answers
  discovery's preflight and adds its headers to discovery's reads, which keep the `*` where it
  sets no origin.
- Authentication keeps a route's own `Cache-Control`, which 0.8.0's `middleware` replaced with
  `no-store`; every other response to a request it authenticates, and a failure enclosing middleware
  serializes, is still `no-store`. An MCP endpoint's answer to an anonymous request, discovery, its
  listing or a public tool's call, gets none, as a public HTTP route's does. A route stating its own
  says `private` unless its answer is the same for every caller: a credential a proxy forwards is
  invisible to a cache in front of that proxy.

#### MCP

| 0.8.0                                                                              | 0.10.0                                                                                                                                                     |
| ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ActionMcp.Options<Errors, R>` of `layerHttp`, `ActionMcp.StdioOptions<Errors, R>` | `ActionMcp.LayerHttpOptions<E, R>`; `ActionMcp.Options<E, R>` is the server's, which `layerHttp` and `runStdio` both take; `E` and `R` are its `features`' |
| `Layer.launch(ActionMcp.layerStdio(implementations, options))`                     | `ActionMcp.runStdio(implementations, options)`, which succeeds when the host closes stdin                                                                  |

- An endpoint serving a protected action names its descriptor, `authentication: Login`, and requires
  its provider. One endpoint serves public and protected tools on one URL: discovery,
  `server/discover` and `tools/list`, and a public tool's call pass without a credential, or with
  one the scheme decodes as empty, a credential they present is verified, and refused with 401 if it
  does not verify, as MCP authorization requires, and every other request authenticates before the
  endpoint reads its body, a protected tool's call and every native feature's request, listings,
  completions and subscriptions included. An endpoint of protected tools alone authenticates every
  request. 0.8.0 authenticated whatever endpoint the host wrapped, and kept public tools on an
  endpoint of their own: merge them, or keep two endpoints to leave the protected tools unlisted to
  signed-out callers ([ActionMcp.md](docs/ActionMcp.md#rules)). The routing headers decide as they
  are: a Base64-encoded tool name names no public tool, and authenticates. A protected tool's call
  without a credential is a 401 before its arguments are decoded, malformed ones included, on a
  mixed endpoint too. A public tool never gets an identity, and a public prompt or resource beside
  protected tools takes an endpoint of its own.
- `runStdio` takes no `authentication`: the host provides the identity of its protected tools
  around it.
- `runStdio` gives its program a `Console` whose every method writes to stderr, so console loggers
  such as `Logger.consoleJson`, `Console.log`, and the counters, timers and group labels Node's
  console prints on stdout never corrupt the protocol from its builders, authorizers and handlers. A
  counter or a timer prints its label and its count or the milliseconds since it started, a group
  prints its label without indenting what follows, and `clear` does nothing. Layers provided around
  it run outside its program: apply `ActionCli.logToStderr` last, before `runMain`, in place of
  0.8.0's `Logger.LogToStderr` outermost, `disableErrorReporting` and `tapCause` block. It moves
  their default logger to stderr, and reports there what `runMain` would report on stdout, but does
  not move their `Console` output or `Logger.consoleJson`: log JSON there with
  `Logger.withConsoleError(Logger.formatJson)`.
- `ActionMcp.layerHttp` and `runStdio` throw for an action whose input is not one object with
  keys, such as a union, an array, a scalar, or an object without keys such as a given
  `Schema.Struct({})`, naming the actions:
  `MCP tool input must be one object with keys, such as a struct: <name>`. Such input compiled,
  and the layer build died with `McpServer cannot register tool '<name>'`.
- `mcp.text` is removed, and every tool's result is Effect's own, as each revision sends it: on
  2026-07-28 the whole encoded success as `structuredContent`, and its JSON as one text block, with
  the success's `outputSchema` listed ([ActionMcp.md](docs/ActionMcp.md#rules)). 0.8.0 sent the
  field raw as the first text block, then the rest, leaving it out of `structuredContent` and
  `outputSchema`; the field is now in both, and JSON-escaped in the text. A program reading the rest
  from `structuredContent` finds the field there too, and `Testing.mcpClient` decodes every success
  from it.

#### Toolkit

| 0.8.0                                                                    | 0.10.0                                                                                                                                                                                                |
| ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ActionToolkit.Binding<Tools, E, R>`, `ActionToolkit.Options<Errors, R>` | `ActionToolkit.Tools<T, E, R>`, the same `{ toolkit, layer }`, each type argument required; `ActionToolkit.Options<A>`, over every action of the implementations, holds `actions` and `needsApproval` |

- A Toolkit tool takes and gives JSON, as MCP's does: `tools.handle` takes JSON arguments, and
  a tool's schemas are `Schema.toCodecJson` of the action's. 0.8.0 decoded a model's JSON with
  the action's schemas, refusing an ISO string for a `Schema.Date`. Pass `tools.handle` the
  JSON a model sends, such as that ISO string.
- A Toolkit tool belongs to its implementation. Two implementations with tools of one name,
  such as two of one action behind different authorizers, never run each other's
  handlers, their layers provided together in either order; 0.8.0 found a tool's handler by
  its name alone, so one layer answered every toolkit's tool of that name, behind that
  layer's own `before`. The `layer` of any `make` call serves the tools of its
  implementations in any `toolkit`, an agent's fewer tools included, so toolkits made per agent
  or per approval policy run with one
  handler layer, built once. Two layers of one implementation, built apart with
  different services and provided together, serve its tools from one of them: use separate
  implementations for separate services. `toolkit` is still a native `Toolkit`, which
  `Toolkit.merge` combines with other tools.

#### CLI

| 0.8.0                                                                                                                            | 0.10.0                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| -------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ActionCliClient.command(Http, "users", "getUser", { connection })`, `ActionCliClient.group(...)`                                | `ActionCli.remoteCommand(Http, GetUser, { client: { baseUrl } })`, `ActionCli.remote(Http, { name, client })`: `client` takes `ActionHttp.client`'s options, on the host's `HttpClient`                                                                                                                                                                                                                                                             |
| `ActionCli.command(app, "name")`, `ActionCli.group(app)`                                                                         | `ActionCli.command(implementations, Action)`, `ActionCli.make(implementations, { name })`                                                                                                                                                                                                                                                                                                                                                           |
| `ActionCli.Options` of `command`, `GroupOptions`; `ActionCliClient.Options`, `GroupOptions`, `Connection`                        | `ActionCli.CommandOptions` of `command`, `RemoteCommandOptions` of `remoteCommand`; `ActionCli.Options` of `make`, `RemoteOptions` of `remote`; `CommandOptions<typeof Action>` takes the action, where 0.8.0's `Options<Output, …>` took its success                                                                                                                                                                                               |
| A command failing with the action's failure itself: `Effect.catchTag("UserNotFound", ...)` after `Command.run`                   | `ActionCli.UserError<E>`, Effect CLI's `CliError.UserError` whose `cause` and `reason` are the failure: `Effect.catchReason("UserError", "UserNotFound", ...)`, Effect's own                                                                                                                                                                                                                                                                        |
| `Effect.tapCause(...)`, `Logger.LogToStderr` and `NodeRuntime.runMain({ disableErrorReporting: true })` around `Command.runWith` | `Command.run(cli, { version })` on `NodeRuntime.runMain`, after `ActionCli.logToStderr` where stdout feeds scripts (below)                                                                                                                                                                                                                                                                                                                          |
| `--input '<json>'`, `--input-file`, `parameters` and its `input` mapper                                                          | Flags from the input: `--tenant-id acme`; `--input "$(cat x.json)"` for an input that is not a struct; a syntax `name`, `positional` and `render` cannot express, such as a flag alias, a flag named apart from its field, or nested input built from several flags, is a native `Command.make` calling `Action.client`, or `ActionHttp.client` over HTTP, whose failures it maps to `CliError.UserError` ([ActionCli.md](docs/ActionCli.md#rules)) |

- Commands and flags are kebab case: `get-user`, `--tenant-id`. A required boolean is a switch;
  any other required field's flag, left out, is refused by the parser before the implementation
  is built, `Missing required flag: --<flag>` on stderr after the command's help on stdout.
  Colliding names throw `Duplicate command` or `Duplicate flag` when the command is built.
  `remoteCommand` and `remote` take their connection as `client`, the options `ActionHttp.client`
  takes, `baseUrl` and `transformClient`, which reach their own requests alone: 0.8.0's
  `connection` without `transformResponse`. A URL or token read when a command runs, as from
  `Config`, configures the `HttpClient` provided on the command,
  `Command.provideEffect(HttpClient.HttpClient, ...)`.
- A field holding an array of strings or numbers, choices included, takes a repeated flag, one
  element per occurrence: `--provider exa --provider hn`. Given none, a required field is `[]`
  and an optional one is left out; a `Schema.NonEmptyArray` field's flag is required once. An
  occurrence of `[]` adds no element, so `--tags '[]'` alone sends `[]`, clearing an optional
  field. An array field listed last in `positional` takes the same values as repeated
  arguments, `rm a b`; listed before another, it throws
  `Repeated positional argument before another one: <field>`. Any other array takes JSON.
- A command whose action fails prints the failure on stderr as the JSON HTTP sends for it, such
  as `{"_tag":"UserNotFound","id":"9"}`, through Effect's CLI formatter, and exits 1, or with
  the failure's `Runtime.errorExitCode`. It fails with Effect CLI's `UserError`, whose `cause`
  is the action's failure, which `Command.run` prints and marks reported, so `runMain` does not
  print it again. 0.8.0 failed the command with the action's failure itself, which `runMain`
  printed on stdout with a stack and without its fields, and the documented program printed the
  raw `Cause` on stderr instead; delete that block. A failure no schema encodes, a builder's or
  the transport's, prints as its tag, or an error's name, and its message, and each cause's, up
  to one already printed, never its other fields. `Command.run` prints a command's failure
  before a host's `Effect.catchReason("UserError", ...)` runs, so a host that recovered silently or
  printed its own text provides a `formatError` through `CliOutput.layer`, or runs with
  `renderErrors: false`.
- A command refuses input that does not decode with `Action.InvalidInput`, as HTTP does,
  printed as the body of HTTP's 400, an undeclared field in `--input` or a flag's JSON
  included, which 0.8.0 dropped. 0.8.0's parser refused an `--input` or `--input-file` value
  that did not decode and showed the command's help (`ShowHelp` containing `InvalidValue`);
  an omitted input that did not decode, or the input a `parameters` mapping made, failed with
  a `SchemaError`.
- A success that does not encode is a defect, as it is HTTP's empty 500, and nothing prints it
  as a result; 0.8.0 failed the command with a `SchemaError`.
- What a command runs, the builder, authorizer and handler, or a remote command's client
  call, and the codecs of its input, success and failures, writes its Effect logs and `Console`
  output to stderr, whatever logger prints them, and the command writes only its result to stdout.
  0.8.0 wrote them to stdout unless the program provided `Logger.LogToStderr`, which moves only the
  default logger. The global `console.log` and other direct writes bypass Effect and still reach
  stdout: keep them off stdout. Layers the host provides, on the command or around the run, log
  outside the command, and `runMain` reports a defect, and a failure of such a layer, on stdout: a
  CLI whose stdout feeds scripts applies `ActionCli.logToStderr` last, before `runMain`, which moves
  those layers' default logger to stderr and reports there what `runMain` would, with its exit code,
  but does not move their `Console` output or `Logger.consoleJson`
  ([ActionCli.md](docs/ActionCli.md#rules)).
- A local command's `UserError` includes `Action.BuiltIn`, whatever its implementation's authorizer.
- A protected action's command, a Toolkit tool and an `Action.client` method owe its identity
  per call, whether or not the handler reads it; one call without it anyway fails with
  `Unauthenticated` before `authorize` runs.

#### Testing

| 0.8.0                                                                                                                                     | 0.10.0                                                                                                                                                                                                                                                                                                                                           |
| ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `Testing.httpClient(api, handler)`, `Testing.Handler`                                                                                     | `Testing.layer(handler)`: the native `HttpClient`, answered by the web handler, on which `ActionHttp.client(Http)` and every other client call it; `Testing.layer(routes)` builds the routes itself                                                                                                                                              |
| `Testing.mcpCall(handler, { url, name, arguments, headers })`, resolving `{ isError: false, value, text? }` or `{ isError: true, error }` | `Testing.mcpClient(actions, { url?, transformClient? })`, then `mcp.<action>(input)`: the decoded success, or a typed failure                                                                                                                                                                                                                    |
| `Testing.mcpRequest({ url, method, params, headers })`, a `Request`                                                                       | `Testing.mcpRequest(method, params?, { url?, headers? })`, the native request: send it with `HttpClient.execute`, or as a web `Request`, `HttpClientRequest.toWebResult`                                                                                                                                                                         |
| `Testing.McpCallOptions`, `McpCallResult`, `McpRequestParams`, `McpRequestValue`                                                          | None: `mcpClient` types each call, and `params` are JSON                                                                                                                                                                                                                                                                                         |
| `TestingClient.withMcpClient`, `McpClientOptions`, the optional `@modelcontextprotocol/client` peer                                       | Depend on the official client, `new Client(info, { versionNegotiation: { mode: { pin: "2026-07-28" } } })`. Give its transport `fetch: (input, init) => web.handler(new Request(input, init))`, with `web = HttpRouter.toWebHandler(routes.pipe(Layer.provide(HttpServer.layerServices)))` as 0.8.0's tests built it; or use `Testing.mcpClient` |

### Additions

- `Authentication.make` refuses, in its types, a `security` that is no native scheme, such as a
  record of them, before the run time throws; `layer` refuses a `protectedResource` for a
  scheme other than Bearer the same way.
- `Action.make` refuses a `Context.Reference` as `caller`, in its types and at run time
  (`Invalid caller: an identity is a Context.Service, not a Context.Reference`): a reference is
  never missing, so its default would stand in for every caller who supplies none.
- `Action.implement` throws `A public-only target takes no authorize` when plain JavaScript gives
  `authorize` to public actions alone, which would never run, as its types already refuse.
- `ActionHttp.fetchClient(Http, { baseUrl, transformClient, fetch })` is `client` built once
  over `fetch`, outside an Effect: its methods are the same Effects and require nothing, so a
  browser app or a script runs each call with `Effect.runPromise`. A call sends with the
  `fetch` option, or with the global `fetch` as the call finds it, so a test's stub installed
  later is used. It replaces
  the three lines every Promise caller repeated around `client`: `FetchHttpClient.layer`,
  `FetchHttpClient.Fetch` and `Effect.runSync`.
- `Action.InvalidInput.fromSchemaError(error)` is the `InvalidInput` every surface answers a
  `Schema.SchemaError` with, its message and its `issues`, for code that decodes input of its
  own, such as a header or a route parameter, and answers as the surfaces do.
- `input` and `success` take plain fields: `input: { id: Schema.String }`. `input: {}`, or no
  `input`, is an action without input: a strict empty object, the root MCP needs. A given
  schema, `Schema.Struct({})` included, is kept as it is.
- `success` is optional: omitted, it is `Schema.Void`, and a CLI command prints nothing by
  default or with `--json`; a custom `render` may print text.
- An `undefined` option takes its default, as an omitted one does, and one that may be either
  is typed as either: `success: enabled ? Schema.String : undefined` gives `string | void`.
- `authorize` may be an Effect that builds it, as a builder builds handlers. What the Effect
  yields, such as a permission store, is a startup requirement, provided once beside the
  builders' services; what the authorizer it returns yields, such as the caller, stays per
  request. It is built once per layer graph for its implementation, and per invocation of a
  local command. A 0.8.0 hook that read a store owed it per request, supplied with
  `HttpRouter.provideRequest` on each surface: yield the store in the Effect instead, and
  provide its layer at startup. A 0.8.0 hook built in `Layer.unwrap` around a surface becomes
  that Effect, which `implement` builds once per implementation in each layer graph: build what
  several implementations or the surfaces share outside it. A service whose value is the
  authorizer, `{ authorize: Guard }`, is built once for every implementation it guards.
- `ActionHttp.layer(Http, implementations, { middleware })` runs native `HttpApiMiddleware`
  around every route it serves, inside authentication and outside decoding, the first listed
  innermost. It may require the identity where every action the layer serves is protected, and
  fails only with the binding's `error` or a built-in error, such as an address allowlist's
  `Action.Forbidden`, so a limit keyed by the caller runs before decoding; one after decoding,
  on every surface, is the handler's. It may fail with a binding error only where the binding surely
  declares it, in a slot of its own of a list of fixed length.
- `Action.client(implementations)` calls implementations in process: one method per action, taking
  its input directly, as `ActionHttp.client`'s methods do, so moving between an in-process and a
  remote caller changes the line acquiring it. A call runs as a remote one does, through the
  dispatch every surface shares: its input passes through its JSON codec, encoded to JSON text then
  decoded, the authorizer and the handler run in a scope of their own, and the success
  or the failure passes through its codec too. It fails with the action's errors and the built-in
  ones, as a remote caller decodes them: input that does not pass is `InvalidInput`, before the
  authorizer, and a success or a failure that does not, an error the action does not declare
  included, is a defect, as it is an empty 500 over HTTP: its `SchemaError`, then the failure
  itself. Each call owes what the authorizer and the handler read, the caller's identity
  included, provided around the call, never around the acquisition. Acquiring it builds the
  implementations into the layer graph around it, as a layer does, sharing each builder's run with
  the surfaces of that graph: acquire it in a builder, a layer or a scoped program, never per
  request. It is how an implementation's own behavior is tested, several callers in one test, an
  action no binding holds included; `Testing.layer` tests what a surface adds. `actions` lists fewer
  of their actions. `Action.Client<Apps>` is its type.

  ```ts
  const asAlice = Effect.provideService(CurrentActor, alice); // each call's caller

  Effect.gen(function* () {
    const users = yield* Action.client(userActions); // once, where builders live
    return yield* users.renameUser({ id: "1", name: "Bea" }).pipe(asAlice);
  });
  ```

- A binding states where it mounts, `Http.prefix`: `/api` by default, `/` at the root, without
  a trailing slash.
- The package declares `"sideEffects": false`, so a bundler may drop what a browser client
  does not use. Keep contracts and bindings in modules that import no server code
  ([setup.md](docs/setup.md#browser)).
- `scopesRequired` names the scopes every 401 of a protected resource asks for, so a first
  login requests the least rather than every scope supported. `layer` and `refusalResponse`
  refuse a `scopesSupported` or `scopesRequired` entry that is no OAuth scope token, as
  `Forbidden` refuses one, so an application checks no scope of its own.
  `Invalid scope in scopesSupported: "<scope>"` names it.
- `Action.Forbidden` may name the OAuth scopes a call lacks, `scopes: ["users:write"]`. On an
  authenticated route it is a 403 with an `insufficient_scope` challenge, on which an MCP
  client re-authorizes and retries.
- `Authentication.protect(descriptor)` is native router middleware for a route of the host's
  own, such as an export, a page frame or a WebSocket upgrade: the descriptor's provider
  verifies the credential its scheme decodes and gives the route the identity, and the route is
  answered as an action's, its refusals and challenges, a `Forbidden` it fails with stepping up
  under Bearer, and `no-store` on every response to a request it authenticates.
- `Authentication.refusalResponse(error, { authentication, protectedResource, authorization })` is
  the response authentication answers a refusal with: its status, JSON, `Cache-Control: no-store`
  and challenge. A caller the router never routes, such as a Node `upgrade` handler admitting a
  socket, refuses with it rather than building a challenge of its own
  ([Authentication.md](docs/Authentication.md#outside-the-router)). Given `authentication`, a
  descriptor of another scheme, it answers as that descriptor's routes do: its 401 names that
  scheme, and nothing steps up.
- `Authentication.bearerTokenOf(authorization)` reads an `Authorization` header value, an
  `Option` of the `Redacted` token, for that same caller, which holds the header and no
  request. It and `refusalResponse`'s `authorization` take the header as the web `Headers.get`
  returns it, `null` when absent, with no `?? undefined`. It reads it as Effect's
  `HttpApiSecurity.bearer` does, the reading a Bearer descriptor's verifier receives: the
  whitespace around the value stripped, as HTTP parsers do, then the rest of the header after
  the scheme and its spaces, `a b` for `Bearer a b`.
- `Authentication.layer`'s `protectedResource` may be an Effect that builds it, as a builder
  builds the verifier: for a resource known only at startup, such as one read from a
  service. It runs once per layer graph.
- `ActionMcp.runStdio` serves MCP 2025-11-25 and 2025-06-18, beside 2026-07-28, as the host
  negotiates, so hosts that open with `initialize`, such as Claude Code and Codex, connect; a host
  asking for an earlier revision is offered 2025-11-25. This reverses 0.6.0's "Stdio hosts must
  speak 2026-07-28", which 0.7.0 kept on purpose for uniformity with HTTP, and which made 0.8.0's
  `layerStdio` refuse them. HTTP still serves 2026-07-28 only: Codex, which opens HTTP with
  `initialize` as well, connects over stdio ([ActionMcp.md](docs/ActionMcp.md#failure-modes)). MCP
  successes stay bare on every transport and revision, as in 0.8.0: on 2026-07-28
  `structuredContent` is the encoded success and the text content is its JSON. On the revisions
  0.8.0 refused, Effect's adapters decide what is structured: 2025-11-25 and 2025-06-18 carry only
  an object success as `structuredContent` and list only an object-rooted `outputSchema`. A success
  they do not structure is text alone, its JSON or, for a string success, the string itself, so a
  host on those revisions reads a non-object success from the text.
- `ActionHttp.layer`, `ActionMcp.layerHttp`, `runStdio`, `ActionToolkit.make` and `ActionCli.make`
  take `actions`, the actions they serve among the implementations', `ActionHttp.layer` among its
  binding's, so a mixed implementation's protected actions take identity middleware in a layer of
  their own without being split: each keeps its implementation's authorizer and its builder's one
  run, an implementation holding none is not built, and only the listed actions' inputs and names
  are checked for the surface. The types take only actions of the implementations, and owe only what
  the listed actions, and the builders holding them, need. A listed action none of them holds throws
  `Listed in actions, but no implementation holds it: <names>`. Omitted, every action is served, as
  before. `ActionCli.remote` takes it from a binding too. Options whose `actions` may be absent, an
  optional property or a union with options lacking it, serve every action, so they owe what every
  action owes; `Action.client` gives such options methods, and `ActionToolkit.make` tools, only for
  the actions they may list. `needsApproval`'s `call` is typed by every action of the
  implementations, which a check of `call.name` narrows, so a reusable `ActionToolkit.Options` value
  is typed by all of them. An explicit type argument names the options' type, not the actions, and
  requires the options argument:
  `ActionMcp.layerHttp<typeof app, { readonly actions: readonly [typeof Status] }>(...)`.
  `ActionHttp.layer`, which takes options or none, reads `middleware` that may be absent the same
  way: such options owe what any of the middleware requires and provide nothing; a reusable value
  names its tuple, `ActionHttp.LayerOptions<readonly [typeof Audit]>`. `ActionHttp.make` reads
  `error` so: options that may leave them out declare them or none, as the binding has at run time,
  so clients decode them and no layer middleware may fail with them, and explicit type arguments
  naming `error` require the options argument; a layer middleware fails only with an error a fixed
  tuple slot of its own declares, never one of an array of unknown length or a slot of several.
  `make` takes public-only actions alone, or any actions with options: a helper forwarding options
  that may be absent passes `options ?? {}`. A misspelled option is a type error beside `actions`
  and `middleware` too, on every surface, each CLI command's options included.

  ```ts
  export const Tools = [GetUser, RenameUser] as const; // beside the contracts
  ActionMcp.layerHttp([users, pages], { name, version, authentication: Login, actions: Tools });
  ActionToolkit.make(users, { actions: Tools });
  ```

- `ActionCli.logToStderr`, applied last before `runMain`, keeps stdout to a program's results: the
  default logger of every layer within writes to stderr, and what `runMain` would report on
  stdout, a defect or a failure of a layer the host provides, is reported on stderr once, with
  the exit code `runMain` gives, the defect standing for it carrying the original `Cause` as its
  `cause`. A command's failure `Command.run` printed is not reported
  again. An MCP subprocess applies it after `runStdio`.
- A command's `UserError` has a `reason`, its `cause`, so Effect's own
  `Effect.catchReason("UserError", "UserNotFound", f)` and `catchReasons` match an action's
  failure by its tag.
- `ActionMcp.layerHttp`'s `path` defaults to `/mcp`, where 0.8.0 required it.
- `ActionMcp.layerHttp` and `runStdio` take `features`, a layer of Effect's own
  `McpServer.resource`, `McpServer.prompt` and `McpServer.toolkit`, served beside the actions'
  tools on the same endpoint. Merged beside the endpoint instead, they register on another
  registry and are not served. A native tool of an action's name is refused when the endpoint
  builds, `Duplicate MCP tool: <name>, claimed by an action and a native feature`.
- `ActionToolkit.make(implementations, { needsApproval })` has `LanguageModel` ask for
  approval of a model's call before it runs, through Effect's native `Tool.needsApproval`:
  one rule over every call, `(call, context) =>` a boolean or an `Effect` of one, where
  `call` holds the action's `name`, the `action` and the decoded `input`. Checking
  `call.name` narrows `call.input`, across implementations too. The check requires nothing
  and runs in the caller's context, so it reads the caller with `Effect.serviceOption`, and
  one toolkit serves callers with different policies. A check that fails means no approval
  is needed, as `LanguageModel` decides natively. `tools.handle` ignores approval.

  ```ts
  ActionToolkit.make([users, documents], {
    needsApproval: (call) => call.name === "erase" && call.input.id !== "draft",
  });
  ```

- A CLI flag's help text is its field's schema description, and a positional argument's label
  is its flag's, `value` for one taking JSON or text.
- `ActionCli.command` and `ActionCli.make`'s `commands` take `aliases`, a flag's short name by
  field, `{ aliases: { limit: "n" } }`, through native `Param.withAlias`.
- `mcp` takes `title` and `_meta`, an MCP tool's display title and its `_meta`, through native
  `Tool.Title` and `Tool.Meta`.
- `ActionMcp.layerHttp` and `runStdio` take the options' type as their second type argument,
  `<Apps, O, E, R, D>`, as `ActionToolkit.make` and `Action.client` do, and native `features`
  owe no `McpServer`, which the endpoint provides them.
- `Authentication.refusalResponse` refuses what `layer` refuses, and both refuse a protected
  resource with a fragment, which discovery could never answer:
  `A protected resource has no fragment`.
- A suspended error keeps its `httpApiStatus` over
  HTTP. Layer middleware chosen by a condition within one slot provides nothing, so what one
  choice would provide stays owed.
- `Testing.mcpClient` reads tool results with the native `McpSchema.CallToolResult`.
- `Action` exports `BuildServices` and `BuildError`, and `ActionHttp` `MethodError`, the types a
  surface's layer and a client's method are written in, so a package emitting declarations may
  export them.
- `ActionCli` exports `RemoteOptions` and `RemoteCommandOptions`, what `remote` and
  `remoteCommand` take, `client` included, and `ActionToolkit` `ToolCall`, the call
  `needsApproval` receives, so options and an approval rule written apart from their call are
  typed.
- `Action.Handlers<typeof actions>` types a builder's record written apart from `implement`, as
  another authorizer of the same handlers takes, so each handler is typed from its contract.
- `Authentication` exports `Descriptor`, `Provider` and `Protection`, the types `make`, `layer`
  and `protect` return, so a package emitting declarations may export a descriptor, a binding
  naming one, a provider and router middleware, `Authentication.Protection<Principal, Name>`,
  rather than writing out `HttpRouter.Middleware<{ ... }>`. `Descriptor<I, A, S, Name, E>`
  carries the errors its verifier declares, `E`, as a list, which `Action.Errors` constrains,
  `<E extends Action.Errors>`: the list type every `error` option holds.
- A descriptor whose scheme the deployment decides, such as a cookie name a framework prefixes
  over HTTPS, is built at startup under the name and identity of the browser's static one.
  `ActionHttp.layer` refuses, as a defect when it builds, a binding whose descriptor is not the
  very value its provider was built from, since the routes would decode one credential and
  declare one descriptor's errors, and MCP and `protect` another's.
- `Action.Refusal` and `Action.BuiltIn` are schemas as well as types, so code outside Effect
  tells a failure apart without listing the classes:

  ```ts
  // before
  const isRefusal = Schema.is(Schema.Union([Action.Unauthenticated, Action.Forbidden]));
  // after
  const isRefusal = Schema.is(Action.Refusal);
  const isExpected = Schema.is(Schema.Union([...Action.BuiltIn.members, NotFound]));
  ```

- `Action.Issue` is one of `InvalidInput`'s `issues`, a `path` and a `message`, so code mapping
  them names their type rather than declaring its own.
- `Action.Implementation<Actions, RequestServices, EX, RX, RA, EAX, RAX>` may be written out:
  the actions, each action's per-request services by name, its builder's failures and services,
  then its authorizer's per-request services and its authorizer builder's, each `never` when
  left out. This reverses "inferred, never spelled out": a package whose interface holds an
  implementation built from its own generic, as the clankerauth SDK's `session` is, can name it
  in no other way, and its declarations printed the authorizer's requirements under a private
  `~authorize` key of the record by action name, which binds them to this package's internals.
  The authorizer's requirements are their own parameter now, and nothing internal is printed.
- `ActionCli.make(implementations, { name, commands })`, and `remote(binding, ...)`, give a
  subcommand the options `command` takes, by action name:
  `commands: { readFile: { positional: ["path"], render } }`. Each takes any action of its
  target, so one record serves aggregates of several `actions`: a command of an action left out
  is unused, and a key naming no action of the target throws `Unknown commands: <keys>`.
- `ActionCli.command(implementations, Action, { positional: ["path"] })` takes the listed fields
  of a struct input as positional arguments, as `remoteCommand` does over HTTP. A suspended
  input or field, as a recursive schema is written, takes the flags and arguments of the schema
  it stands for, and its description.
- `Testing.layer(routes)` answers any `HttpClient` user in memory: `ActionHttp.client`, the
  native `HttpApiClient`, a remote `ActionCli` command and `Testing.mcpClient`, which calls
  tools as `ActionHttp.client` calls routes. Requests run in the context it is built in, as
  under `HttpRouter.serve`, and what the routes still require, such as their builders'
  services, is provided around it. It never requires the platform
  services `FileSystem`, `Path`, `HttpPlatform` and `Etag.Generator`: one provided around it
  is the routes' own, and `HttpServer.layerServices`' defaults stand in for the rest, whose
  `FileSystem` is a no-op. Its client is its own: the program's other HTTP clients get none of
  its requests, and it none of theirs.

### Other changes

- `Action` and `ActionHttp`, and every module they import, import Effect only through
  `effect`, `effect/http` and `effect/http-api`, so a page that loads Effect from an import
  map serving them bundles no second copy; setup.md says what such a map serves. A Vite+
  bundle is unchanged; an esbuild bundle of a page calling `ActionHttp.client` grows by about
  5.6 kB gzipped.
- The docs add failure modes for a builder that runs twice, a job or an agent beside
  `HttpRouter.serve` reading other state than the routes, and surfaces all answering with one
  surface's startup services. A model loop in a route yields its toolkit in its implementation's
  builder, and the route's layer takes the toolkit's `layer` with `Layer.provide`: one build,
  shared with every surface of the routes' graph serving its implementations. `Effect.provide`
  in the handler builds it for every call unless a surface of the graph serves the same
  implementations, and `HttpRouter.provideRequest` in a graph of its own, a second time beside
  such a surface that has not built them first
  ([ActionToolkit.md](docs/ActionToolkit.md#rules)).
- The failure modes of a forgotten authentication show what TypeScript reports,
  `Provider<CurrentActor, "example.Login">` among a layer's requirements, and
  `Type 'Provider<...>' is not assignable to type 'never'` where the server is launched,
  and why no identity provided at startup or per request stands in for it
  ([Authentication.md](docs/Authentication.md#failure-modes)).
- Authentication.md adds a rule: the verifier checks a token's audience, that it was issued for this
  `resource`, as MCP authorization requires (RFC 8707). `Authentication.layer` reads no token; one
  issued for another resource fails with `Unauthenticated`, as any token that does not verify.
- Authentication.md adds a rule: router middleware provided around routes runs before their
  authentication, and a check that must also cover discovery and unrouted requests, such as a
  Host or Origin policy, is global middleware, `HttpRouter.middleware(check, { global: true })`,
  merged beside the routes, as the example app's request policy now is.
- guarantees.md adds a rule: a handler maps another service's refusals before failing
  with them. An `Unauthenticated` or `Forbidden` that a client such as `ActionHttp.client`
  decodes is, passed on as it is, this server's own: on an authenticated route it sends a
  caller whose token is valid to sign in again, its 401 naming `invalid_token`, or to
  re-authorize for the other service's scopes
  ([authorization](docs/guarantees.md#authorization)).
- guarantees.md states that every MCP tool call, over HTTP and over stdio, and every Toolkit
  call runs through Effect's `Toolkit.handle`, which records the call's arguments as sent on
  the current span, as `parameters`, a `Schema.Redacted` field's value included, as in 0.8.0;
  HTTP records no request body. Where a tracer exports spans, keep an action that takes a
  secret off tools ([observability](docs/guarantees.md#observability)).
- guarantees.md's wire table gives MCP's answers to a body that is not JSON, a JSON-RPC
  `Parse error` (`-32700`) with 200 over HTTP and none over stdio, to a missing or non-JSON
  content type, an empty 415, to another HTTP method on the endpoint, an empty 405 with
  `Allow: POST`, and to an unknown tool, a JSON-RPC `-32602` error, with 200 over HTTP.
- ActionMcp.md adds a rule: closing stdin interrupts every call in flight, and `runStdio`
  succeeds once they have stopped, after any uninterruptible region has completed. An
  interrupted call gets no result: no answer, or a JSON-RPC error. MCP hosts close stdin to
  shut a server down; a script piping requests keeps stdin open until it has read every
  answer.
- The docs and examples provide a command's services and caller on the command,
  `Command.provide(Users.layer)` and `Command.provideSync(CurrentActor, actor)`, built or read when
  the command runs, before its input is decoded, so input the action's schema refuses is refused
  after they are built; `--help` and the parser's errors, such as a missing or unknown flag, never
  build them. Provided around the run, as 0.8.0 showed, they are built before the arguments are
  parsed. A remote command's connection is configured on the command too, with `client` or, for
  settings read when it runs, `Command.provideEffect(HttpClient.HttpClient, ...)`, so no other
  request of the program takes its URL or credentials. `make`'s aggregate run alone still builds its
  provisions before showing its help, and fails instead if one fails.
- The docs state what a message for input that does not decode says on every surface: what
  the schema expects and, where Effect's decoder reports one, each issue's path, never a value
  sent; a path names the keys it passes through, a record's included
  ([guarantees.md](docs/guarantees.md#wire-behavior)).
- The skill, read from the repository whatever version a project installs, sends an agent in a
  project that installs the package to that version's own pages in node_modules, and shows the
  module its snippets import for the identity and `authorize`. The routing table says when to read
  each page, CONTEXT.md included, and CONTEXT.md defines a layer graph, a public and a protected
  action, an authorizer, an authentication descriptor and its provider, and startup
  services.
- The examples implement the agent-only `listChanges` beside the other user actions, which
  HTTP's binding leaves out, serve public and protected actions from one HTTP layer and one MCP
  endpoint, and give an operator's CLI
  a trusted identity beside remote callers (`examples/cli-admin.ts`).

## 0.9.0

Built and tested against `effect` and `@effect/platform-node` `4.0.0`, the first stable
release of Effect 4. The `effect` peer is now `^4.0.0`.

### Breaking changes

**The `effect` peer requires Effect 4.0.0 or a later 4.x release.** Release candidates no
longer satisfy it. Nothing in this package's API or behaviour changed.

- Migrate: install `effect` and `@effect/platform-node` `4.0.0` or later. Effect's own 4.0.0
  release notes list its changes since rc.118; this package needed none of them.

## 0.8.0

Built and tested against `effect` and `@effect/platform-node` `4.0.0-rc.118`. The `effect`
peer now starts at rc.118 (`>=4.0.0-rc.118 <4.0.0`).

### Breaking changes

**The `effect` peer starts at `4.0.0-rc.118`.** rc.118 moved Effect's HTTP, HTTP API, CLI, AI
and process modules out of `effect/unstable/*`, and the package imports them from their new
paths, so an older release candidate fails with `Cannot find module 'effect/http'`.

- Migrate: install `effect` and `@effect/platform-node` `4.0.0-rc.118`, and import
  `effect/http`, `effect/http-api`, `effect/cli`, `effect/ai` and `effect/process` instead of
  `effect/unstable/http`, `effect/unstable/httpapi`, `effect/unstable/cli`,
  `effect/unstable/ai` and `effect/unstable/process`.

**MCP tools send their success without the `{ value }` envelope.** `structuredContent` is the
encoded success itself, of any JSON type, and the text content is its JSON. A tool's
`outputSchema` describes the encoded success. MCP 2026-07-28, the only revision served, allows
any JSON value there and any `outputSchema` root. Errors are unchanged.

- Migrate: an MCP client reads `structuredContent` instead of `structuredContent.value`.
  `Testing.mcpCall` already unwrapped the envelope, so its `value` is unchanged.

  ```ts
  // before: {"structuredContent":{"value":42},"content":[{"type":"text","text":"{\"value\":42}"}]}
  // after:  {"structuredContent":42,"content":[{"type":"text","text":"42"}]}
  ```

**HTTP input is closed.** An HTTP server refuses an input field the action does not declare:
an empty 400, or the group's `schemaError` `invalid` answer. Such fields were stripped before.
Typed HTTP clients fail with `SchemaError` on an undeclared field, before sending. The
published OpenAPI already said `additionalProperties: false`, and MCP tools were already
strict.

- Migrate: stop sending the extra fields, or declare them in the action's `input`.

### Additions

- `mcp.text` names a string field of the encoded success, such as a document body. MCP sends
  it once, raw, as the first text block, followed by the JSON of the rest, and leaves it out
  of `structuredContent` and of the listed `outputSchema`. A success without the field, which
  may be optional, is sent whole. Other surfaces serve the whole success. Building the MCP
  layer fails when the field is not a top-level property of the success's JSON Schema, as for
  a union of structs.

  ```ts
  export const ReadPage = Action.make("readPage", {
    description: "Read one page of a document as Markdown.",
    input: Schema.Struct({ url: Schema.String }),
    success: Schema.Struct({ markdown: Schema.String, next: Schema.optionalKey(Schema.String) }),
    access: "read",
    mcp: { name: "read_page", text: "markdown" },
  });
  ```

- `Testing.mcpCall` resolves a success with `text`, the text field, when one was sent, and
  accepts any JSON `structuredContent`.
- `ActionCatalog` entries record `mcp.text` in `mcp`.

### Other changes

- `ActionCatalog` schemas are closed (`additionalProperties: false`), as in the OpenAPI
  document.
- `ActionGroup.make` no longer refuses two actions with the same MCP tool name. The Toolkit or
  MCP binding that serves both refuses them, so a group served only over HTTP may keep them.
- `docs/ActionMcp.md` lists the fields the native server adds to every result
  (`_meta["io.modelcontextprotocol/serverInfo"]` and `resultType`), so a result's encoded size
  can be computed.

## 0.7.0

Built and tested against `effect` and `@effect/platform-node` `4.0.0-rc.117`. The `effect`
peer range is unchanged (`>=4.0.0-rc.116 <4.0.0`).

### Breaking changes

**`ActionHttpClient.promise` has no `token` option.** Its options are now the native
`HttpApiClient.make` options `baseUrl` and `transformClient`, passed through, plus `fetch`.
The native `transformResponse` is not offered: it may change a call's success, failure or
required services, which neither the method types nor `Effect.runPromise` can follow.

- Migrate: replace `token` with a `transformClient`, or with a `fetch` wrapper for a token read
  on each call:

  ```ts
  import { HttpClient, HttpClientRequest } from "effect/unstable/http";

  // before
  ActionHttpClient.promise(Http, { baseUrl, token });

  // after
  ActionHttpClient.promise(Http, {
    baseUrl,
    transformClient: HttpClient.mapRequest(HttpClientRequest.bearerToken(token)),
  });
  ```

**`Action.make` has no `http` option.** HTTP serves every action of every group passed to
`ActionHttp.make`. Keeping an action off HTTP means putting it in a group that the HTTP binding
leaves out. There is no local-only action any more: `ActionCli` runs any action. `Action.Action`
and `Action.Options` lose their `Http` type parameter, so `Mcp` moves up one position, and an
action has no `http` field. `ActionCatalog` entries lose their `http` field, `httpSchemaErrors`
lists a group's policy errors for every action, and the catalog `version` is `"4"`. `make`
refuses keys that `Action.Options` does not declare, so a leftover `http` is a compile error
rather than an action that is now served. `make` infers the whole options object: its type
parameters are now `<Name, O>` instead of `<Name, Input, Output, Errors, Acc, Http, Mcp>`, so
explicit type arguments or instantiation expressions no longer compile.

- Migrate: delete `http: true`. For an action with `http: false`, move it to a group of its own
  (or of other actions hidden from HTTP), and leave that group out of `ActionHttp.make` while
  still passing it to `ActionMcp`, `ActionToolkit` or `ActionCli`:

  ```ts
  // before
  const ListChanges = Action.make("listChanges", { ..., http: false });
  const Users = ActionGroup.make({ name: "users" }, GetUser, ListChanges);
  const Http = ActionHttp.make({ apiPath: "/api" }, Users);

  // after
  const ListChanges = Action.make("listChanges", { ... });
  const Users = ActionGroup.make({ name: "users" }, GetUser);
  const Audit = ActionGroup.make({ name: "audit" }, ListChanges);
  const Http = ActionHttp.make({ apiPath: "/api" }, Users);
  // Audit's implementation goes to ActionMcp.layerHttp, ActionToolkit.make or ActionCli.
  ```

  Catalog readers: drop `http`, and check for `version: "4"`. Explicit `Action.make<...>` type
  arguments: delete them and let `make` infer.

  Library authors: a package whose published declarations were built against effect-actions
  0.6.0 or earlier names `Action.Action` with seven type arguments. Under 0.7.0 those
  references do not resolve, and with `skipLibCheck` its contracts silently degrade to `any`.
  Rebuild and republish such a package against 0.7.0 before its consumers upgrade.

**An `mcp` option that may serve the action keeps its requirements.** An action is typed hidden
from MCP only when its options' type has a required `mcp: false`, such as a literal
`mcp: false`. A conditional spread of `{ mcp: false }` and an `Action.Options` value whose `mcp`
is optional were typed hidden although they may serve the action, so an MCP layer dropped the
handler's request requirements and a served tool could fail on a missing service. They are now
typed served: the action's `mcp` type includes the resolved tool, and `ActionMcp` layers keep
the handler's requirements. `ActionToolkit` applies the same rule: every action whose `mcp` type
is not exactly `false` is a tool of the toolkit's type, carrying its handler's request
requirements. Before, an action whose `mcp` might be `false` at runtime (the forms above,
`false | undefined`, or `enabled ? { name } : false`) had no tool in the type although it had one
at runtime, and calling it could fail on a service the types never asked for. Literal
`mcp: false`, `mcp: { ... }` hints and omitted `mcp` infer exactly as before. A ternary
between hints and `false` (`enabled ? { name: "nt" } : false`) now types the tool name as
`string`; add `as const` to the hints branch to keep the literal name.

- Migrate: nothing for literal options. Where a layer or a toolkit call now requires a service
  it did not before, the action may be served: provide the service, or state `mcp: false`
  literally.

**Handlers must be own-property functions of a plain record.** 0.6.0 refused a record without
an own property for an action, or with `undefined` there. `implement` now also refuses one whose
value is not a function. A record that fails is refused with
`Missing handlers for group "<group>": <actions>`, at `implement` or, for a builder Effect's
record, when the adapter layer builds; before, a non-function value failed on its first request.
Handlers are called without a receiver.

- Migrate: nothing, unless a record held non-function values under action names; bind a
  function for every action.

### Other changes

- `ActionHttpClient.promise` and `Testing.httpClient` build the native client the same way,
  over `FetchHttpClient` with the given `fetch`. `promise` still looks the global `fetch` up on
  each call when none is passed.
- `Testing.mcpCall` reads `arguments` with a destructuring default; an omitted `arguments` is
  still sent as `{}`.
- `ActionMcp` documents that stdio refuses a host speaking an older revision deliberately, for
  uniformity with HTTP, although stdio has no sessions.

## 0.6.0

Built and tested against `effect` and `@effect/platform-node` `4.0.0-rc.117`. The `effect`
peer range is unchanged (`>=4.0.0-rc.116 <4.0.0`).

### Breaking changes

**MCP is 2026-07-28 only.** `ActionMcp.layerHttp` and `ActionMcp.layerStdio` no longer take
`protocols`; both serve `McpProtocol.v2026_07_28` and nothing else. Over HTTP the endpoint is
stateless: no `initialize` handshake and no session. A 2025-era client (one that opens with
`initialize`) is refused: over HTTP with status 400 and JSON-RPC error `-32020`, over stdio with
JSON-RPC error `-32022` on `initialize`. Stdio hosts must speak 2026-07-28. Without a
session, `notifications/cancelled` interrupts nothing over HTTP.

- Migrate: delete `protocols` from every `layerHttp`/`layerStdio` call, and delete local
  protocol lists (`[McpProtocol.v2026_07_28]` and the four-revision stdio lists). Clients
  must speak 2026-07-28; pin the official client with
  `versionNegotiation: { mode: { pin: "2026-07-28" } }`.

**`TestingClient.withMcpClient` has no `versionNegotiation` option.** It always pins
2026-07-28, the one revision served.

- Migrate: delete `versionNegotiation` from `withMcpClient` options.

**A group's `schemaError` policy states two answers; the library chooses between them.**
`{ errors, map }` is replaced by `{ invalid: { schema, make }, internal: { schema, make } }`.
A native `HttpApiSchemaError` from decoding the request (`Payload`, `Params`, `Headers`,
`Query`) is answered by `invalid`; one from encoding the handler's result (`Body`,
`ResponseHeaders`) by `internal`. `make` receives the failure and returns its schema's value.
`ActionGroup.SchemaErrorPolicy` now takes `<Invalid, Internal>` codecs instead of an error
tuple, `ActionGroup.SchemaErrorAnswer` is new, and a group's third type parameter is the union
of its policy's error codecs rather than a tuple.

- Migrate:

  ```ts
  // before
  const schemaError = {
    errors: [InvalidInput, InternalFailure],
    map: (failure: HttpApiError.HttpApiSchemaError) =>
      failure.kind === "Body" || failure.kind === "ResponseHeaders"
        ? new InternalFailure({ message: "The response could not be encoded." })
        : new InvalidInput({ message: failure.cause.message }),
  };

  // after
  const schemaError = {
    invalid: {
      schema: InvalidInput,
      make: (failure: HttpApiError.HttpApiSchemaError) =>
        new InvalidInput({ message: failure.cause.message }),
    },
    internal: {
      schema: InternalFailure,
      make: () => new InternalFailure({ message: "The response could not be encoded." }),
    },
  };
  ```

  A `make` that reads its failure needs the parameter annotation in a standalone constant
  (inline in `ActionGroup.make` it is inferred). Policies that branched on
  `kind === "Payload"` answered `Params`, `Headers` and `Query` as internal; those kinds never
  occur on action routes, so nothing observable changes.

**`implement` refuses a handler record that lacks an action.** A plain record throws at
`implement`; a builder Effect's record fails the adapter layer's build. Before, the missing
handler was a defect on the first request for that action. The message is now
`Missing handlers for group "<group>": <actions>`. Every adapter also selects its handlers
once, when it builds, rather than per request.

- Migrate: nothing, unless a record was deliberately incomplete; the types already required
  every handler.

### Additions

- `ActionMcp` options are the native `McpServer.layerHttp` / `layerStdio` options minus
  `protocols`, passed through unchanged: `description`, `websiteUrl`, `icons` and `extensions`
  now reach the server.
- `Http.openApi(path?)`: the binding's OpenAPI document as one `GET` route, at
  `<apiPath>/openapi.json` unless a path is given. Replaces
  `HttpRouter.add("GET", "/api/openapi.json", HttpServerResponse.jsonUnsafe(OpenApi.fromApi(Http.api)))`;
  pass `"/openapi.json"` to keep a root path.
- `ActionHttpClient.promise(Http, { baseUrl?, token?, fetch? })`, a new subpath
  `@gjermundgaraba/effect-actions/ActionHttpClient`: `client.<group>.<action>(input)` for every
  HTTP-served action, resolving with the decoded success. It rejects with what the native
  `HttpApiClient` fails with: a declared error value (the action's, the policy's, or the
  binding's surface `errors`), a native `HttpClientError` (unreachable: `response` is
  `undefined`; or an undeclared status or unreadable body), or a `SchemaError`. `token` is sent
  as a bearer; `fetch` defaults to the global one, looked up per call; an omitted `baseUrl`
  keeps routes relative (the page's origin). It replaces hand-written wrappers of
  `Effect.runSync(HttpApiClient.make(...))`, `FetchHttpClient.Fetch`, a bearer
  `transformClient` and a `run` that re-throws failures; any classification of statuses into
  application errors stays with the caller. Other headers go through a wrapping `fetch`.
- `Testing.mcpCall(handler, { url, name, arguments?, headers? })`: one stateless `tools/call`,
  resolving with `{ isError: false, value }` (the `{ value }` envelope removed) or
  `{ isError: true, error }` (the error text, parsed as JSON when it is a declared error). It
  throws for a non-200 answer or a JSON-RPC error; `mcpRequest` still covers those. It replaces
  test helpers that parse the JSON or event-stream body and unwrap `structuredContent.value` or
  the `isError` text.

### Effect 4.0.0-rc.117

rc.117 generates MCP tool `outputSchema` differently (a top-level `$ref` is inlined). Every
effect-actions tool output is rooted at its `{ value }` object, so published tool schemas are
unchanged.
