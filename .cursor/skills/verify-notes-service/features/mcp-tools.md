# Call an MCP tool

Call an MCP tool lets a client list the notes tools without a token, ask the public status, and create a note that the JSON API then lists. Both surfaces share the server's notes.

## Sub-features

- `tools-list` returns every tool name, including `createNote` and `getStatus`, with no token.
- `tools-status` calls `getStatus` and returns `structuredContent.service` `notes-service`.
- `tools-create` calls `createNote` with token `ada`.
- `tools-shared` shows that note from `POST /api/listNotes` on the same server.

## How to get to it (user POV)

- `POST /mcp` with method `tools/list` and no bearer token.
- `POST /mcp` with method `tools/call`, name `getStatus`, and empty arguments.
- `POST /mcp` with method `tools/call`, name `createNote`, arguments `title` and `body`, and `Authorization: Bearer ada`.
- `POST /api/listNotes` with the same token.

## Driving it with notes-verify

Preconditions:

- `notes-verify doctor` printed `doctor ok` for this run.
- `POST /api/getStatus` reports `"notes":0`.

Headers on every `/mcp` request: `accept: application/json, text/event-stream`, `mcp-protocol-version: 2026-07-28`, and `mcp-method` set to the JSON-RPC method. A call also sends `mcp-name` equal to the tool name.

- **List.** Run `.cursor/skills/verify-notes-service/helpers/notes-verify http --token none --evidence tools-list.http.txt POST /mcp --header 'accept: application/json, text/event-stream' --header 'mcp-protocol-version: 2026-07-28' --header 'mcp-method: tools/list' --data '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{"_meta":{"io.modelcontextprotocol/clientCapabilities":{},"io.modelcontextprotocol/clientInfo":{"name":"effect-actions","version":"0"},"io.modelcontextprotocol/protocolVersion":"2026-07-28"}}}'`. Status `200`. Body contains `"name":"createNote"` and `"name":"getStatus"`.
- **Status.** Run `.cursor/skills/verify-notes-service/helpers/notes-verify http --token none --evidence tools-status.http.txt POST /mcp --header 'accept: application/json, text/event-stream' --header 'mcp-protocol-version: 2026-07-28' --header 'mcp-method: tools/call' --header 'mcp-name: getStatus' --data '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"getStatus","arguments":{},"_meta":{"io.modelcontextprotocol/clientCapabilities":{},"io.modelcontextprotocol/clientInfo":{"name":"effect-actions","version":"0"},"io.modelcontextprotocol/protocolVersion":"2026-07-28"}}}'`. Status `200`. `result.structuredContent` is `{"service":"notes-service","notes":0}` and `result.isError` is false.
- **Create.** Run `.cursor/skills/verify-notes-service/helpers/notes-verify http --token ada --evidence tools-create.http.txt POST /mcp --header 'accept: application/json, text/event-stream' --header 'mcp-protocol-version: 2026-07-28' --header 'mcp-method: tools/call' --header 'mcp-name: createNote' --data '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"createNote","arguments":{"title":"MCP Plan","body":"From a tool"},"_meta":{"io.modelcontextprotocol/clientCapabilities":{},"io.modelcontextprotocol/clientInfo":{"name":"effect-actions","version":"0"},"io.modelcontextprotocol/protocolVersion":"2026-07-28"}}}'`. Status `200`. `result.structuredContent.title` is `MCP Plan`, `body` is `From a tool`, `revision` is `1`, and `result.isError` is false.
- **Shared store.** Run `.cursor/skills/verify-notes-service/helpers/notes-verify http --token ada --evidence tools-list-notes.http.txt POST /api/listNotes --data '{}'`. Status `200`. `notes` contains `MCP Plan`.

## Gotchas

- `tools/list` on this server answers `200` with no token. A protected call other than the public `getStatus` does not. Send `Bearer ada` for `createNote`.
- The protocol revision on the headers and inside `_meta` is `2026-07-28`. A body without that `_meta` is not the request this endpoint's stateless client sends.
- `mcp-name` matches `params.name`. `getStatus` arguments are `{}`.
- Success for a tool call is `result.structuredContent`, not only HTTP `200`.
- The stdio entrypoint is a different process and a different memory store. A note created there does not show up in this server's `listNotes`. This recipe uses `POST /mcp` on the launched server only.
