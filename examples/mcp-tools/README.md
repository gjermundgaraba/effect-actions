# mcp-tools

An MCP server whose tools wrap one upstream HTTP API: here, a 3D print farm's. It has no
authentication of its own. It signs in to the farm once, with its own account, and whoever can
reach it may call every tool, so it runs as a local subprocess of an agent or on a network only
trusted clients are on.

Start here if you are putting an existing API in front of a model. For tools that belong to the
signed-in user, start from [notes-service](../notes-service/).

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
endpoint accepts and answers with CORS headers, comma-separated; `HOST` is the interface it listens on.

## Layout

```text
src/
├── printers/
│   ├── Printers.ts    contract: the printer, the one declared error, the five tools
│   ├── farm.ts        PrintFarm, the upstream API as a service, and its Layer
│   ├── fake.ts        DEMO ONLY: the farm's API answered in memory, as an HttpClient
│   └── handlers.ts    Action.implement: tool to service
├── instructions.ts    the server's name, version and its instructions for the model
├── routes.ts          the HTTP surface: /mcp and /healthz
├── server.ts          entrypoint: MCP over HTTP
└── stdio.ts           entrypoint: MCP for a local agent
test/
├── printers/          in process, with Action.client, over fake upstreams
└── routes.test.ts     over MCP in memory, with Testing.layer
```

- **The upstream is a service, built once.** `PrintFarm.layer` reads its URL and credentials
  from `Config`, takes whichever `HttpClient` the entrypoint provides, and signs in while it is
  built. The handlers get it already signed in and only delegate.
- **One declared error, mapped in one place.** A refusal, an unreachable farm, an answer of
  another shape and one that never comes each leave `farm.ts` as a `PrintFarmError` with a
  message a model can act on. No handler catches anything.
- **What a model sends is checked by the contract.** A printer id becomes part of the farm's
  URL, so its schema admits only what is safe there, and anything else is refused before a
  handler runs.
- **One implementation, two transports.** `server.ts` and `stdio.ts` serve the same `printers`
  with the same `serverInfo`; they differ in what they provide around it.
- **The contract is the tool.** A tool's name, description, input schema, hints and title all
  come from `Printers.ts`.

## Where to look

| To see                                                          | Read                             |
| --------------------------------------------------------------- | -------------------------------- |
| Public tools described for a model, with field descriptions     | `src/printers/Printers.ts`       |
| `readOnly`, `title`, `destructiveHint` and `idempotentHint`     | `src/printers/Printers.ts`       |
| One declared error shared by every tool                         | `src/printers/Printers.ts`       |
| An input a model cannot use to reach another URL                | `src/printers/Printers.ts`       |
| A tool answering an image beside other fields                   | `src/printers/Printers.ts`       |
| An upstream client reading `Config`, signing in once            | `src/printers/farm.ts`           |
| An upstream's failures mapped to the declared error             | `src/printers/farm.ts`           |
| A builder yielding a service, and handlers that only delegate   | `src/printers/handlers.ts`       |
| Server `instructions`, shared by both transports                | `src/instructions.ts`            |
| Allowed origins from `Config`, and `/healthz`                   | `src/routes.ts`                  |
| A request body limit, and where an unauthenticated server binds | `src/server.ts`                  |
| A stdio server whose logs go to stderr                          | `src/stdio.ts`                   |
| A fake upstream provided as a Layer, to a test or an entrypoint | `src/printers/fake.ts`           |
| Testing tools and each upstream failure's message in process    | `test/printers/printers.test.ts` |
| Testing listed hints, an image and the origin check in memory   | `test/routes.test.ts`            |
