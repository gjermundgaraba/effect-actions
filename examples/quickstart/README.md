# quickstart

The smallest complete program: one action, served as a JSON route and as an MCP tool, called
with its typed client. It is the skeleton of [notes-service](../notes-service/), which adds
authentication, authorization, declared errors, a store, a CLI and a browser client to the same
layout.

## Run it

From the repository root, after `vp install` (from an installed package, see
[Run one](../README.md#run-one)):

```sh
node --import tsx examples/quickstart/src/server.ts     # 127.0.0.1:3000
node --import tsx examples/quickstart/src/client.ts     # Hello, Ada!
vp test examples/quickstart
```

## Layout

```text
src/
├── greeting/
│   ├── Greeting.ts    the contract
│   └── handlers.ts    its implementation
├── Api.ts             the HTTP binding, shared by server and client
├── routes.ts          the surfaces: POST /api/greet and /mcp
├── server.ts          entrypoint
└── client.ts          entrypoint
test/routes.test.ts    the routes, called in memory
```
