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

The application has three groups, one per access rule:

| Group    | Actions                                     | HTTP           | MCP                           |
| -------- | ------------------------------------------- | -------------- | ----------------------------- |
| `public` | `status`                                    | no credentials | `/mcp/public`, no credentials |
| `users`  | `getUser`, `renameUser`, `double`, `whoAmI` | bearer token   | `/mcp`, bearer token          |
| `audit`  | `listChanges`                               | not served     | `/mcp`, bearer token          |

HTTP groups share one mount path and differ by middleware. An MCP endpoint is a single
route, so its middleware covers every tool. That is why the public tool has its own endpoint.
The OpenAPI document (`/openapi.json`) and a Swagger UI (`/docs`) are public as well; both
are Effect's own tools reading the native `Http.api`.

```sh
# The public group needs no token
curl -s http://127.0.0.1:3000/api/actions/public/status \
  -H 'Content-Type: application/json' -d '{}'
# {"service":"effect-actions","users":2}

# A generated HTTP RPC endpoint over the getUser action
curl -s http://127.0.0.1:3000/api/actions/users/getUser \
  -H 'Authorization: Bearer alice' \
  -H 'Content-Type: application/json' \
  -d '{"id":"1"}'
# {"id":"1","name":"Ada"}

# A generated HTTP route; the schema transforms "21" to numeric 21
curl -s http://127.0.0.1:3000/api/actions/users/double \
  -H 'Authorization: Bearer alice' \
  -H 'Content-Type: application/json' \
  -d '{"value":"21"}'
# 42

# The same action over MCP. The 2026-07-28 revision is stateless, so a single
# request needs no initialize handshake. These examples select only this revision.
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

# Generated OpenAPI 3.1 document, covering every HTTP group
curl -s http://127.0.0.1:3000/openapi.json
```

For MCP discovery, use `MCP-Method: tools/list` and `"method":"tools/list"` with the same `_meta`. Every actor sees the same tool list. A tool call the application's authorization rejects returns an `isError` result. The HTTP endpoint runs the same handler and so the same check.

## Application structure

- [contracts.ts](contracts.ts): schemas, per-action `access`, the three action groups, the shared schema-error policy, and the bound `Http` contract, including the surface errors its clients decode.
- [auth.ts](auth.ts): demo actors, identity, permissions, authorization errors, and the `before` hook every guarded surface binds.
- [users.ts](users.ts): an in-memory, tenant-scoped repository with a change log.
- [handlers.ts](handlers.ts): one implementation per group, with startup and request dependencies and no authorization code.
- [app.ts](app.ts): `Authentication.middleware` on the `users` group only, the `before` hook on the guarded HTTP layer and MCP endpoint, the Host/Origin policy around everything, and adapter registration.
- [server.ts](server.ts): the Node HTTP server and shutdown handling.
- [client.ts](client.ts): runnable typed HTTP calls using the demo `alice` token.

## Follow a request

```text
HTTP getUser / MCP get_user
  → authentication middleware provides CurrentActor
  → before hook reads access: "read" and checks users:read
      (HTTP runs it before decoding; MCP decodes arguments first)
  → adapter decodes input
  → handler calls Users.get(actor.tenantId, id)
  → adapter encodes the user or declared error
```

`UserNotFound` uses HTTP 404 and is declared on the actions that can raise it. `Forbidden`
(403) and `Unauthenticated` (401) are declared on the `Http` binding instead, because the
hook and the authentication middleware produce them rather than a handler; declaring them is
what lets [client.ts](client.ts) decode a refusal as a typed failure. Every error response
carries `cache-control: no-store`. MCP returns an `isError` tool
result whose text is the same encoding HTTP sends. Tool discovery is not filtered by actor.

A write through `renameUser` is visible through both transports, and through the MCP-only
`list_changes` tool. `double`
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
node --import tsx examples/cli-client.ts

# Native Effect Toolkit result, without an MCP envelope
node --import tsx examples/toolkit.ts

# Offline JSON catalog; no implementation or server startup
node --import tsx examples/catalog.ts
```

[cli.ts](cli.ts) and [cli-client.ts](cli-client.ts) return native Effect CLI commands;
use `--help` for their options. [mcp-stdio.ts](mcp-stdio.ts) is a subprocess MCP
server to launch from an MCP client, not an interactive shell command. It reserves
stdout for JSON-RPC and routes Effect logs to stderr.
