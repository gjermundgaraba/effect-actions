# Authenticated HTTP and MCP example

Run `vp run example` from the repository root after `vp install`.
In another terminal, run `node --import tsx examples/client.ts` for typed HTTP calls.

The example listens on **127.0.0.1:3000**. It uses an in-memory repository and deliberately fake bearer tokens:

| Token    | Actor / tenant | Permissions             |
| -------- | -------------- | ----------------------- |
| `alice`  | alice / acme   | users:read, users:write |
| `reader` | reader / acme  | users:read              |
| `bob`    | bob / other    | users:read, users:write |

**Do not deploy these credentials or this authentication implementation.** State resets when the process restarts.

```sh
# A generated HTTP RPC endpoint over the getUser action
curl -s http://127.0.0.1:3000/api/actions/getUser \
  -H 'Authorization: Bearer alice' \
  -H 'Content-Type: application/json' \
  -d '{"id":"1"}'
# {"id":"1","name":"Ada"}

# A generated HTTP route; the schema transforms "21" to numeric 21
curl -s http://127.0.0.1:3000/api/actions/double \
  -H 'Authorization: Bearer alice' \
  -H 'Content-Type: application/json' \
  -d '{"value":"21"}'
# 42

# The same action over MCP. The 2026-07-28 revision is stateless, so a single
# request needs no initialize handshake. Older revisions negotiate a session
# first; see the official-client tests.
curl -s http://127.0.0.1:3000/mcp \
  -H 'Authorization: Bearer alice' \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H 'MCP-Protocol-Version: 2026-07-28' \
  -H 'MCP-Method: tools/call' \
  -H 'MCP-Name: double' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"double","arguments":{"value":"21"},"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientCapabilities":{},"io.modelcontextprotocol/clientInfo":{"name":"curl","version":"0"}}}}'
# ... "structuredContent":{"value":42} ...

# Generated OpenAPI 3.1 document
curl -s http://127.0.0.1:3000/openapi.json \
  -H 'Authorization: Bearer alice'
```

For MCP discovery, use `MCP-Method: tools/list` and `"method":"tools/list"` with the same `_meta`. Every actor sees the same tool list; a tool call the application's authorization rejects returns an `isError` result. The HTTP endpoint runs the same handler and therefore the same check.

## Application structure

- [contracts.ts](contracts.ts): user schemas and action contracts.
- [auth.ts](auth.ts): identity, permissions, and authorization errors.
- [users.ts](users.ts): an in-memory, tenant-scoped repository.
- [handlers.ts](handlers.ts): handlers with startup and request dependencies.
- [app.ts](app.ts): `Authentication.middleware`, application Host/Origin policy, and adapter registration.
- [server.ts](server.ts): the Node HTTP server and shutdown handling.
- [client.ts](client.ts): runnable typed HTTP calls using the demo `alice` token.

## Follow a request

```text
HTTP getUser / MCP get_user
  → authentication middleware provides CurrentActor
  → adapter decodes input
  → handler checks users:read
  → Users.get(actor.tenantId, id)
  → adapter encodes the user or declared error
```

`UserNotFound` uses HTTP 404 and `Forbidden` uses 403. MCP returns the same
encoded errors in an `isError` tool result. Tool discovery is not filtered by actor.

A write through `renameUser` is visible through both transports. `double`
demonstrates string-to-number input decoding. `whoAmI` reads the authenticated
identity from request context, not action arguments.

See [dependency lifetimes](../docs/behavior.md#dependency-lifetimes) for how the
handlers share `Users` while resolving `CurrentActor` on each request.
