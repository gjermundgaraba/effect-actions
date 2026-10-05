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

Every action declares `access: "read"` or `access: "write"`. The protected implementations name
their hook once, `authorize`: the HTTP and MCP layers serving them authenticate the bearer
token, and every surface, the CLI and the Toolkit included, runs the `before` hook, which maps
`access` to `users:read` / `users:write` and refuses with the built-in `Action.Forbidden`,
naming the scope the caller lacks. The public `status` states `Action.allowAll` instead. No
handler repeats this action-level policy, and no surface can leave the rule out. Record-level
access stays in `Users`, which scopes data by tenant.

The application serves its implementations under three access rules:

| Implementation | Actions                           | HTTP           | MCP                           |
| -------------- | --------------------------------- | -------------- | ----------------------------- |
| `status`       | `status`                          | no credentials | `/mcp/public`, no credentials |
| `userActions`  | `getUser`, `renameUser`, `whoAmI` | bearer token   | `/mcp`, bearer token          |
| `double`       | `double`                          | bearer token   | `/mcp`, bearer token          |
| `userActions`  | `listChanges`                     | not served     | `/mcp`, bearer token          |

Every HTTP action is in one binding, `Http`: one mount path, one document, one client, served
by two `ActionHttp.layer` calls, the protected one with the authentication around it. The
binding decides what HTTP serves, so `listChanges`, which it leaves out, has no route, though
`userActions` holds it. The `Users` builder runs once, though HTTP and MCP both serve
`userActions`. An MCP endpoint is a single
route, so authentication around it covers every tool: the public tool has an endpoint of its
own, which keeps the protected tools unlisted to signed-out callers.
[mcp-sign-in.ts](mcp-sign-in.ts) serves both kinds from one URL instead.
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

# The public MCP endpoint lists and runs its one tool without a token
curl -s http://127.0.0.1:3000/mcp/public \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H 'MCP-Protocol-Version: 2026-07-28' \
  -H 'MCP-Method: tools/list' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientCapabilities":{},"io.modelcontextprotocol/clientInfo":{"name":"curl","version":"0"}}}}'
# ... "tools":[{"name":"status", ...

# Generated OpenAPI 3.1 document, covering every HTTP action
curl -s http://127.0.0.1:3000/api/openapi.json
```

For MCP discovery, use `MCP-Method: tools/list` and `"method":"tools/list"` with the same `_meta`. Every actor sees the same tool list. A tool call the application's authorization rejects answers 403 with the `insufficient_scope` challenge naming the missing scope. The implementation carries that hook, so HTTP runs the same check before the handler.

Without a token, a protected route or the `/mcp` endpoint answers 401
`{"_tag":"Unauthenticated","message":"A bearer token is required."}` with
`WWW-Authenticate: Bearer scope="users:read", resource_metadata="http://localhost:3000/.well-known/oauth-protected-resource/mcp"`;
with an unknown one, the message is `Unknown demo token.`, and the challenge also names
`error="invalid_token"` first. An MCP client then finds the authorization server at that URL,
which is public.

## Application structure

- [quickstart.ts](quickstart.ts), [quickstart-server.ts](quickstart-server.ts), [quickstart-client.ts](quickstart-client.ts): the minimal program's contract and binding, its server, and its typed client.
- [contracts.ts](contracts.ts): schemas, errors and actions, each with its `access`.
- [binding.ts](binding.ts): the `Http` binding. Plain data, shared by the server and every client. `listChanges` is left out of it, so HTTP does not serve it. It documents the bearer scheme, `status` public.
- [authorization.ts](authorization.ts): demo actors, identity, permissions, and the `before` hook the protected implementations name.
- [authorization-built.ts](authorization-built.ts): the same rule as a hook built like handlers, not served by the app: a permission store yielded once at startup, the actor on every call.
- [users.ts](users.ts): an in-memory, tenant-scoped repository with a change log.
- [handlers.ts](handlers.ts): `Action.implement` for one action or several sharing a builder, with startup and request dependencies, and the hook of the protected ones.
- [authentication.ts](authentication.ts): `Authentication.make`'s router middleware for an OAuth protected resource, and its layer `authenticate`, publishing its RFC 9728 discovery and answering a missing or unknown token with the built-in 401 and a challenge naming it.
- [authentication-tenant.ts](authentication-tenant.ts): authentication combined with other middleware, not served by the app: a verifier built once at startup, each request's tenant from middleware combined before it, and middleware reading the identity combined after it.
- [authentication-upgrade.ts](authentication-upgrade.ts): `Authentication.refusal` for a caller the router never routes, not served by the app: a socket upgrade authenticating its own header, refused with the response the middleware answers the same refusal with.
- [http.ts](http.ts): the public and the authenticated HTTP layers of one binding, plus the OpenAPI document and Swagger UI.
- [mcp.ts](mcp.ts): the public and the protected MCP endpoints.
- [mcp-sign-in.ts](mcp-sign-in.ts): one MCP URL for signed-out and signed-in callers, not served by the app: an optional identity, a public tool, and a protected one whose hook answers a signed-out caller with the 401 an MCP client signs in on.
- [request-policy.ts](request-policy.ts): the Host/Origin policy for a server bound to localhost, global router middleware, which refuses a foreign Host or Origin before any credential is read.
- [app.ts](app.ts): every surface of the host, behind that policy, merged first so it covers discovery too.
- [server.ts](server.ts): the Node HTTP server, its request body limit, and shutdown handling.
- [client.ts](client.ts): runnable typed HTTP calls using the demo `alice` token.
- [promise-client.ts](promise-client.ts): `ActionHttp.fetchClient`, the client built once outside an Effect, each call a promise.

## Follow a request

```text
HTTP /api/getUser / MCP tool getUser
  → the authentication around the route provides CurrentActor
  → the surface decodes input (invalid input is a 400 InvalidInput over HTTP and an isError
    result over MCP; the hook and handler never run)
  → before hook reads access: "read" and checks users:read
  → handler calls Users.get(actor.tenantId, id)
  → the surface encodes the user or the declared error
```

`UserNotFound` uses HTTP 404 and is declared on the actions that can raise it. `Forbidden`
(403) and `Unauthenticated` (401) are built in: every endpoint and tool declares them, because
the hook and the authentication produce them rather than a handler. That is what
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
Authentication establishes `CurrentActor` on each request, over any value provided at startup.
Never provide it at a server's startup all the same: a route no authentication covers would
serve every caller as that actor. In memory, [testing-caller.ts](testing-caller.ts) provides
one caller around the layer.

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
stderr, and `Logger.LogToStderr` moves the default logger there for the layers provided
around it. Keep the global `console.log` and other direct writes off stdout.

[toolkit.ts](toolkit.ts) prints a native Toolkit result.
[mcp-browser.ts](mcp-browser.ts) exports public stateless MCP routes with an explicit Origin
allowlist and separate router CORS configuration; mount them with a platform server.
[toolkit-authorized.ts](toolkit-authorized.ts) demonstrates a Toolkit with the shared
authorization hook and the caller's identity provided per invocation.
[toolkit-approval.ts](toolkit-approval.ts) asks a model's caller to approve its writes, one
check over every call reading the call and the caller.
Run [testing.ts](testing.ts), `node --import tsx examples/testing.ts`, for in-memory HTTP and
MCP calls with cleanup.
[testing-caller.ts](testing-caller.ts) tests `userActions` behind their hook as one caller,
without authentication, sharing the in-memory `Users` with the program.
[in-process.ts](in-process.ts) calls `userActions`, `listChanges` included, which no binding
holds, in process with `Action.client`, as two callers, each given around its own calls: what
the implementation does, with no transport.
