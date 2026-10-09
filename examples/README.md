# Authenticated HTTP and MCP example

Run `vp run example` from the repository root after `vp install`.
In another terminal, run `node --import tsx examples/client.ts` for typed HTTP calls.

The example listens on 127.0.0.1:3000. It uses an in-memory repository and deliberately fake bearer tokens:

| Token    | Actor / tenant | Permissions             |
| -------- | -------------- | ----------------------- |
| `alice`  | alice / acme   | users:read, users:write |
| `reader` | reader / acme  | users:read              |
| `bob`    | bob / other    | users:read, users:write |

Do not deploy these credentials or this authentication implementation. State resets when the process restarts.

Every action declares `readOnly: true` or `readOnly: false`, and who may call it: `status` is
`caller: Action.Anyone`, every other action `caller: CurrentActor`. The HTTP and MCP layers serving a
protected action verify the bearer token through `authenticate`, the verifier of the binding's
`Login`, before decoding its input. The protected implementations state their authorization
once, `authorize`, which every surface, the CLI and the Toolkit included, runs before each
handler: it maps `readOnly` to `users:read` / `users:write` and refuses with the built-in
`Action.Forbidden`, naming the scope the caller lacks. `status` states none, and no
authorization runs for it. No handler repeats this action-level policy, and no surface can
leave the rule out. Record-level access stays in `Users`, which scopes data by tenant.

| Implementation | Actions                           | HTTP           | MCP (`/mcp`)                   |
| -------------- | --------------------------------- | -------------- | ------------------------------ |
| `status`       | `status`                          | no credentials | no credentials                 |
| `userActions`  | `getUser`, `renameUser`, `whoAmI` | bearer token   | bearer token; listed to anyone |
| `double`       | `double`                          | bearer token   | bearer token; listed to anyone |
| `userActions`  | `listChanges`                     | not served     | bearer token; listed to anyone |

Every HTTP action is in one binding, `Http`: one mount path, one document, one client, served
by one `ActionHttp.layer`, which authenticates the protected routes and leaves `status` public.
The binding decides what HTTP serves, so `listChanges`, which it leaves out, has no route,
though `userActions` holds it. The `Users` builder runs once, though HTTP and MCP both serve
`userActions`. One MCP endpoint serves every tool: discovery and `status` answer anyone, and
every other request authenticates before the endpoint decodes it.
The OpenAPI document (`/api/openapi.json`) and a Swagger UI (`/docs`) are public as well; both
are Effect's own tools reading the native `Http.api`, which states the bearer scheme on every
route but `status`.

```sh
# The public action needs no token
curl -s http://127.0.0.1:3000/api/status \
  -H 'Content-Type: application/json' -d '{}'
# {"service":"effect-actions","users":2}

# A generated HTTP RPC endpoint over the getUser action
curl -s http://127.0.0.1:3000/api/getUser \
  -H 'Authorization: Bearer alice' \
  -H 'Content-Type: application/json' \
  -d '{"id":"1"}'
# {"id":"1","name":"Ada"}

# A generated HTTP route; the schema transforms "21" to numeric 21
curl -s http://127.0.0.1:3000/api/double \
  -H 'Authorization: Bearer alice' \
  -H 'Content-Type: application/json' \
  -d '{"value":"21"}'
# 42

# The same action over MCP. The 2026-07-28 revision, the only one served, is
# stateless, so a single request needs no initialize handshake.
curl -s http://127.0.0.1:3000/mcp \
  -H 'Authorization: Bearer alice' \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H 'MCP-Protocol-Version: 2026-07-28' \
  -H 'MCP-Method: tools/call' \
  -H 'MCP-Name: double' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"double","arguments":{"value":"21"},"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientCapabilities":{},"io.modelcontextprotocol/clientInfo":{"name":"curl","version":"0"}}}}'
# ... "structuredContent":42 ...

# The MCP endpoint lists every tool, and runs `status`, without a token
curl -s http://127.0.0.1:3000/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H 'MCP-Protocol-Version: 2026-07-28' \
  -H 'MCP-Method: tools/list' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientCapabilities":{},"io.modelcontextprotocol/clientInfo":{"name":"curl","version":"0"}}}}'
# ... "tools":[{"name":"status", ...

# Generated OpenAPI 3.1 document, covering every HTTP action
curl -s http://127.0.0.1:3000/api/openapi.json
```

Every caller, signed in or not, sees the same tool list. A tool call the application's authorization rejects answers 403 with the `insufficient_scope` challenge naming the missing scope. The implementation carries that `authorize`, so HTTP runs the same check before the handler.

Without a token, a protected route or tool call answers 401, before its input is decoded,
`{"_tag":"Unauthenticated","message":"A bearer token is required."}` with
`WWW-Authenticate: Bearer scope="users:read", resource_metadata="http://localhost:3000/.well-known/oauth-protected-resource/mcp"`;
with an unknown one, the message is `Unknown demo token.`, and the challenge also names
`error="invalid_token"` first. An MCP client then finds the authorization server at that URL,
which is public.

## Application structure

- [quickstart.ts](quickstart.ts), [quickstart-server.ts](quickstart-server.ts), [quickstart-client.ts](quickstart-client.ts): the minimal program's contract and binding, its server, and its typed client.
- [contracts.ts](contracts.ts): schemas, errors and actions, each with its `readOnly` and `caller`.
- [binding.ts](binding.ts): the `Login` authentication descriptor and the `Http` binding. Plain data, shared by the server and every client. `listChanges` is left out of the binding, so HTTP does not serve it. Its protected routes require the bearer scheme, enforced and documented; `status` is public.
- [authorization.ts](authorization.ts): demo actors, the identity `CurrentActor` the protected contracts declare, permissions, and the `authorize` rule the protected implementations state.
- [authorization-built.ts](authorization-built.ts): the same rule built like handlers, not served by the app: a permission store yielded once at startup, the actor on every call.
- [users.ts](users.ts): an in-memory, tenant-scoped repository with a change log.
- [handlers.ts](handlers.ts): `Action.implement` for one action or several sharing a builder, with startup and request dependencies, and the `authorize` of the protected ones.
- [authentication.ts](authentication.ts): `Authentication.layer`, the server-only verifier of `Login`, as `authenticate`, publishing its OAuth protected resource's RFC 9728 discovery and answering a missing or unknown token with the built-in 401 and a challenge naming it.
- [authentication-tenant.ts](authentication-tenant.ts): authentication beside other middleware, not served by the app: a verifier built once at startup, each request's tenant from router middleware provided after it, and endpoint middleware reading the identity, the layer's `middleware`.
- [authentication-route.ts](authentication-route.ts): a route of the host's own beside the actions, not served by the app: `Authentication.protect(Login)` authenticates it with the provider the actions use and gives it the actor, and a scope it requires is a `Forbidden` answered as an action's.
- [authentication-upgrade.ts](authentication-upgrade.ts): `Authentication.refusalResponse` for a caller the router never routes, not served by the app: a socket upgrade authenticating its own header, refused with the response authentication answers the same refusal with on a route.
- [http.ts](http.ts): one HTTP layer serving the public and the protected actions of one binding, plus the OpenAPI document and Swagger UI.
- [mcp.ts](mcp.ts): one MCP endpoint serving the public and the protected tools.
- [request-policy.ts](request-policy.ts): the Host/Origin policy for a server bound to localhost, global router middleware, which refuses a foreign Host or Origin before any credential is read.
- [app.ts](app.ts): every surface of the host, behind that policy, merged first so it covers discovery too.
- [server.ts](server.ts): the Node HTTP server, its request body limit, and shutdown handling.
- [client.ts](client.ts): runnable typed HTTP calls using the demo `alice` token.
- [cli-admin.ts](cli-admin.ts): a trusted operator's command beside remote callers, not served by the app: one implementation and one `authorize`, an identity typed in two parts, so no verified token names the operator the host supplies.
- [promise-client.ts](promise-client.ts): `ActionHttp.fetchClient`, the client built once outside an Effect, each call a promise.
- [rpc-binding.ts](rpc-binding.ts): the `Rpc` binding, the same actions as Effect RPC, one native rpc per action, its protected ones authenticated by `Login`. Plain data, shared by the server and every client.
- [rpc.ts](rpc.ts): `ActionRpc.layer` on Effect's `RpcServer`, not served by the app: a WebSocket at `/rpc` speaking JSON, each protected rpc authenticated per message by `authenticate`, `status` public.
- [rpc-client.ts](rpc-client.ts): `ActionRpc.client` over a WebSocket, against a host serving [rpc.ts](rpc.ts), not the app, in a browser's shape: the token sent on each message with `RpcClient.withHeaders`, since a browser sets no header on the upgrade.

## Follow a request

```text
HTTP /api/getUser / MCP tool getUser
  → authentication verifies the bearer token and provides CurrentActor (without one, a 401
    before the input is read)
  → the HTTP layer's own middleware, if any
  → the surface decodes input (invalid input is a 400 InvalidInput over HTTP and an isError
    result over MCP; authorize and the handler never run)
  → authorize reads readOnly: true and checks users:read
  → handler calls Users.get(actor.tenantId, id)
  → the surface encodes the user or the declared error
```

`UserNotFound` uses HTTP 404 and is declared on the actions that can raise it. `Forbidden`
(403) and `Unauthenticated` (401) are built in: every endpoint and tool declares them, because
authentication and `authorize` produce them rather than a handler. That is what
lets [client.ts](client.ts) decode a refusal as a typed failure. Responses through the
authentication carry `cache-control: no-store`; other routes use the host's cache policy. MCP over HTTP answers
a refusal with the same status and body as HTTP. Tool discovery is not filtered by actor.

A write through `renameUser` is visible through both transports, and through the
`listChanges` tool, which HTTP does not serve. `double`
demonstrates string-to-number input decoding. `whoAmI` reads the authenticated
identity from request context, not action arguments.

See [dependency lifetimes](../docs/guarantees.md#dependency-lifetimes) for how the
handlers share `Users` while resolving `CurrentActor` on each request.

Startup capabilities (`Users`) and request identity (`CurrentActor`) use distinct tags.
Authentication establishes `CurrentActor` on each protected request, and nothing provided at
startup satisfies a protected route: its layer owes `Login`'s verifier. In memory,
[testing-caller.ts](testing-caller.ts) serves the routes behind `authenticate`, each client
sending its caller's token.

## Other surfaces

These examples use the same action contracts without changing their handlers:

```sh
# Local execution; a subcommand per action, a flag per input field
node --import tsx examples/cli.ts get-user --id 1

# Public status action over HTTP; start `vp run example` first
node --import tsx examples/cli-remote.ts

# Native Effect Toolkit result
node --import tsx examples/toolkit.ts

# In process, as two callers
node --import tsx examples/in-process.ts

```

[cli.ts](cli.ts) and [cli-remote.ts](cli-remote.ts) return native Effect CLI commands;
use `--help` for their options. Each prints its result on stdout, and a failure on stderr as
the JSON HTTP sends, such as `{"_tag":"UserNotFound","id":"9"}` for `get-user --id 9`.
[mcp-stdio.ts](mcp-stdio.ts) is a subprocess MCP
server to launch from an MCP client, not an interactive shell command. It reserves
stdout for JSON-RPC: `runStdio` writes its program's Effect logs and `Console` output to
stderr, and `ActionCli.logToStderr` moves the default logger there for the layers provided
around it. Keep the global `console.log` and other direct writes off stdout.
[mcp-image.ts](mcp-image.ts) is another such server, whose tool returns an image: an
`Action.Image` field of its success, which the model receives as an image block beside the
rest of the success.

[toolkit.ts](toolkit.ts) prints a native Toolkit result.
[mcp-browser.ts](mcp-browser.ts) exports public stateless MCP routes with an explicit Origin
allowlist and separate router CORS configuration; mount them with a platform server.
[toolkit-authorized.ts](toolkit-authorized.ts) demonstrates a Toolkit with the shared
`authorize` and the caller's identity provided per invocation.
[toolkit-approval.ts](toolkit-approval.ts) asks a model's caller to approve its writes, one
rule over every call reading the call and the caller.
Run [testing.ts](testing.ts), `node --import tsx examples/testing.ts`, for in-memory HTTP and
MCP calls with cleanup.
[testing-caller.ts](testing-caller.ts) tests `userActions` over HTTP behind their real
authentication, a client per caller's token, sharing the in-memory `Users` with the program.
Run [testing-rpc.ts](testing-rpc.ts), `node --import tsx examples/testing-rpc.ts`, for the same
rpcs in memory over Effect's HTTP protocol, behind their real authentication, each call carrying
its caller's token.
[in-process.ts](in-process.ts) calls `userActions`, `listChanges` included, which no binding
holds, in process with `Action.client`, as two callers, each given around its own calls: what
the implementation does, with no transport.
