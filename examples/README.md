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

Every action declares `access: "read"` or `access: "write"`. The guarded HTTP layer, the
guarded MCP endpoint and the CLI each bind the same `before` hook, which maps that to
`users:read` / `users:write` and refuses with `Forbidden`, so no handler contains
authorization code and the same rule applies over every surface.

The application serves its implementations under three access rules:

| Implementation | Actions                           | HTTP           | MCP                           |
| -------------- | --------------------------------- | -------------- | ----------------------------- |
| `status`       | `status`                          | no credentials | `/mcp/public`, no credentials |
| `userActions`  | `getUser`, `renameUser`, `whoAmI` | bearer token   | `/mcp`, bearer token          |
| `double`       | `double`                          | bearer token   | `/mcp`, bearer token          |
| `listChanges`  | `listChanges`                     | not served     | `/mcp`, bearer token          |

Every HTTP action is in one binding, `Http`: one mount path, one document, one client. The
two `ActionHttp.layer` calls differ only by middleware. The `Users` builder runs once, though
HTTP and MCP both serve `userActions`. An MCP endpoint is a single
route, so its middleware covers every tool. That is why the public tool has its own endpoint.
The OpenAPI document (`/api/openapi.json`) and a Swagger UI (`/docs`) are public as well; both
are Effect's own tools reading the native `Http.api`.

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
# ... "structuredContent":{"value":42} ...

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

For MCP discovery, use `MCP-Method: tools/list` and `"method":"tools/list"` with the same `_meta`. Every actor sees the same tool list. A tool call the application's authorization rejects returns an `isError` result. The HTTP surface binds the same authorization hook, so it enforces the same check before the handler.

## Application structure

- [contracts.ts](contracts.ts): schemas, errors and actions, each with its `access`.
- [binding.ts](binding.ts): the `Http` binding with the errors its clients decode, including its schema-error answers. Plain data, shared by the server and every client. `listChanges` is left out of it, so it is MCP-only.
- [auth.ts](auth.ts): demo actors, identity, permissions, authorization errors, and the `before` hook every guarded surface binds.
- [users.ts](users.ts): an in-memory, tenant-scoped repository with a change log.
- [handlers.ts](handlers.ts): `Action.implement` for one action or several sharing a builder, with startup and request dependencies and no authorization code.
- [authentication.ts](authentication.ts): RFC 9728 discovery, and `Authentication.middleware` answering a missing or unknown token with the declared 401 and its challenge.
- [http.ts](http.ts): the HTTP layers, public and guarded, plus the OpenAPI document and Swagger UI.
- [mcp.ts](mcp.ts): the public and the guarded MCP endpoints.
- [app.ts](app.ts): every surface of the host, under the Host/Origin policy.
- [server.ts](server.ts): the Node HTTP server and shutdown handling.
- [client.ts](client.ts): runnable typed HTTP calls using the demo `alice` token.

## Follow a request

```text
HTTP /api/getUser / MCP tool getUser
  → authentication middleware provides CurrentActor
  → adapter decodes input (invalid input skips the hook and handler)
  → before hook reads access: "read" and checks users:read
  → handler calls Users.get(actor.tenantId, id)
  → adapter encodes the user or declared error
```

`UserNotFound` uses HTTP 404 and is declared on the actions that can raise it. `Forbidden`
(403) and `Unauthenticated` (401) are declared on the `Http` binding instead, because the
hook and the authentication middleware produce them rather than a handler; declaring them is
what lets [client.ts](client.ts) decode a refusal as a typed failure. Responses through the
authentication middleware carry `cache-control: no-store`; other routes use the host's cache policy. MCP returns an `isError` tool
result whose text is the same encoding HTTP sends. Tool discovery is not filtered by actor.

A write through `renameUser` is visible through both transports, and through the MCP-only
`listChanges` tool. `double`
demonstrates string-to-number input decoding. `whoAmI` reads the authenticated
identity from request context, not action arguments.

See [dependency lifetimes](../docs/guarantees.md#dependency-lifetimes) for how the
handlers share `Users` while resolving `CurrentActor` on each request.

Startup capabilities (`Users`) and request identity (`CurrentActor`) use distinct tags.
Never provide `CurrentActor` at startup: adapters retain native Effect context semantics,
not an extra identity-isolation boundary. Authentication establishes it on each request.

## Other projections

These examples use the same action contracts without changing their handlers:

```sh
# Local execution with explicit native CLI flags
node --import tsx examples/cli.ts --value 21

# Public status action over HTTP; start `vp run example` first
node --import tsx examples/cli-remote.ts

# Native Effect Toolkit result, without an MCP envelope
node --import tsx examples/toolkit.ts

# Offline JSON catalog; no implementation or server startup
node --import tsx examples/catalog.ts
```

[cli.ts](cli.ts) and [cli-remote.ts](cli-remote.ts) return native Effect CLI commands;
use `--help` for their options. [mcp-stdio.ts](mcp-stdio.ts) is a subprocess MCP
server to launch from an MCP client, not an interactive shell command. It reserves
stdout for JSON-RPC and routes Effect logs to stderr.

[mcp-browser.ts](mcp-browser.ts) exports public stateless MCP routes with an explicit Origin
allowlist and separate router CORS configuration; mount them with a platform server.
[toolkit-authorized.ts](toolkit-authorized.ts) demonstrates a Toolkit with the shared
authorization hook and a per-invocation principal.
Run `node --import tsx examples/testing.ts` for in-memory HTTP and MCP calls with cleanup.
[promise-client.ts](promise-client.ts) calls the running example from code that does not run
Effects, such as a browser page, and handles a declared error and an unreachable server.
