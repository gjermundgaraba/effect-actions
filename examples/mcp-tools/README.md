# mcp-tools

An MCP server whose tools wrap one upstream HTTP API: here, a 3D print farm's. It has no
authentication of its own. It signs in to the farm once, with its own account, and whoever can
reach it may call every tool, so it runs as a local subprocess of an agent or on a network only
trusted clients are on.

Start here if you are putting an existing API in front of a model, then read
[ActionMcp.md](../../docs/ActionMcp.md). For tools that need a token, its "Protect tools" shows
how to protect them, and [notes-service](../notes-service/) is a server whose tools belong to the
signed-in user.

## Run it

From the repository root, after `vp install` (from an installed package, see
[Run one](../README.md#run-one)):

```sh
export FARM_URL=https://farm.example.test FARM_USER=demo FARM_PASSWORD=demo

node --import tsx examples/mcp-tools/src/server.ts      # MCP at 127.0.0.1:3000/mcp, PORT to change
curl http://127.0.0.1:3000/healthz                      # ok

# The subprocess, given one request on stdin. An agent's host starts it the same way.
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"shell","version":"0"}}}' |
  node --import tsx examples/mcp-tools/src/stdio.ts

vp test examples/mcp-tools
```

The farm is a fake, answered in memory, so any URL, user and password work: replace it with a
real HTTP client before deploying anything. `ALLOWED_ORIGINS` lists the browser origins the HTTP
endpoint accepts and answers with CORS headers, comma-separated; `HOST` is the interface it
listens on.

## Connect a client

Claude Code, to the running HTTP server or starting the subprocess itself; add one of the two:

```sh
claude mcp add --transport http print-farm http://127.0.0.1:3000/mcp

claude mcp add print-farm \
  -e FARM_URL=https://farm.example.test -e FARM_USER=demo -e FARM_PASSWORD=demo \
  -- "$PWD/node_modules/.bin/tsx" "$PWD/examples/mcp-tools/src/stdio.ts"
```

`node --import tsx` finds `tsx` from the directory the process starts in, which the host
chooses. So the line names both files by their full path, which `$PWD` gives it when run from
the repository root; `tsx` runs the `node` on the host's `PATH`. Claude Desktop takes the same
command as an entry of `mcpServers` in its `claude_desktop_config.json`, the paths written out:

```json
{
  "mcpServers": {
    "print-farm": {
      "command": "/path/to/effect-actions/node_modules/.bin/tsx",
      "args": ["/path/to/effect-actions/examples/mcp-tools/src/stdio.ts"],
      "env": {
        "FARM_URL": "https://farm.example.test",
        "FARM_USER": "demo",
        "FARM_PASSWORD": "demo"
      }
    }
  }
}
```

By hand, a tool is called with one request, which states its protocol revision, its method
and its tool's name twice: in the body and in the three `MCP-` headers.

```sh
curl http://127.0.0.1:3000/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H 'MCP-Protocol-Version: 2026-07-28' \
  -H 'MCP-Method: tools/call' \
  -H 'MCP-Name: list_printers' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"list_printers","arguments":{},"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientInfo":{"name":"curl","version":"0"},"io.modelcontextprotocol/clientCapabilities":{}}}}'
```

It answers `{"jsonrpc":"2.0","id":1,"result":{…,"structuredContent":{"printers":[…]},"isError":false}}`.
Every header is needed, as `ActionMcp.layerHttp` says. `tools/list` takes the same request with that method, no `MCP-Name` header,
and no `name` or `arguments`.

## Layout

```text
src/
├── printers/
│   ├── Printers.ts    contract: the printer, the one declared error, the five tools
│   ├── farm.ts        PrintFarm, the upstream as a service: what the handlers call
│   └── handlers.ts    Action.implement: tool to service
├── platform/
│   ├── print-farm.ts  printFarm, PrintFarm's Layer over the farm's HTTP API
│   └── fake-farm.ts   DEMO ONLY: the farm's API answered in memory, as an HttpClient
├── instructions.ts    the server's name, version and its instructions for the model
├── routes.ts          the HTTP surface: /mcp and /healthz
├── server.ts          entrypoint: MCP over HTTP
└── stdio.ts           entrypoint: MCP for a local agent
test/
├── printers/          in process, with Action.client, over fake upstreams
└── routes.test.ts     over MCP in memory, with Testing.layer
```

## Where to look

| To see                                                          | Read                             |
| --------------------------------------------------------------- | -------------------------------- |
| Public tools described for a model, with field descriptions     | `src/printers/Printers.ts`       |
| `readOnly`, `title`, `destructiveHint` and `idempotentHint`     | `src/printers/Printers.ts`       |
| One declared error shared by every tool                         | `src/printers/Printers.ts`       |
| An input a model cannot use to reach another URL                | `src/printers/Printers.ts`       |
| A tool answering an image beside other fields                   | `src/printers/Printers.ts`       |
| An upstream client reading `Config`, signing in once            | `src/platform/print-farm.ts`     |
| An upstream's failures mapped to the declared error             | `src/platform/print-farm.ts`     |
| A builder yielding a service, and handlers that only delegate   | `src/printers/handlers.ts`       |
| Server `instructions`, shared by both transports                | `src/instructions.ts`            |
| Allowed origins from `Config`, their CORS, and `/healthz`       | `src/routes.ts`                  |
| A request body limit, and where an unauthenticated server binds | `src/server.ts`                  |
| A stdio server whose logs go to stderr                          | `src/stdio.ts`                   |
| A fake upstream provided as a Layer, to a test or an entrypoint | `src/platform/fake-farm.ts`      |
| Testing tools and each upstream failure's message in process    | `test/printers/printers.test.ts` |
| Testing listed hints, an image and the origin check in memory   | `test/routes.test.ts`            |
| Testing CORS for one configured origin and for several          | `test/routes.test.ts`            |
