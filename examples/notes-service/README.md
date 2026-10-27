# notes-service

A small service as most applications of this library are built: one set of contracts, one implementation, served as a JSON API and as MCP tools, with a CLI and a browser client on the same binding. Notes belong to the signed-in user; reading needs the `notes:read` scope and writing `notes:write`.

## Run it

From the repository root, after `vp install` (from an installed package, see [Run one](../README.md#run-one)):

```sh
node --import tsx examples/notes-service/src/server.ts          # 127.0.0.1:3000

export NOTES_TOKEN=ada                                          # a demo token: ada, grace or reader
node --import tsx examples/notes-service/src/cli.ts --help
echo "First draft" | node --import tsx examples/notes-service/src/cli.ts create-note --title Plan
node --import tsx examples/notes-service/src/cli.ts list-notes
node --import tsx examples/notes-service/src/cli.ts export notes.md   # a command written by hand
node --import tsx examples/notes-service/src/cli.ts import notes.md   # one importNotes call

# The stdio server, given one MCP 2026-07-28 request on stdin
echo '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"getStatus","arguments":{},"_meta":{"io.modelcontextprotocol/clientCapabilities":{},"io.modelcontextprotocol/protocolVersion":"2026-07-28"}}}' |
  node --import tsx examples/notes-service/src/stdio.ts

vp test examples/notes-service
```

An agent host connects to the running server, and so to the notes the API holds:

```sh
claude mcp add --transport http notes http://127.0.0.1:3000/mcp --header "Authorization: Bearer ada"
codex mcp add notes --url http://127.0.0.1:3000/mcp --bearer-token-env-var NOTES_TOKEN
```

`src/stdio.ts` is another way in: a subprocess the host starts, with a store of its own. `src/worker.ts` serves the same routes as a `fetch` handler, for a serverless host such as Cloudflare Workers ([ActionMcp.md](../../docs/ActionMcp.md#serve-tools-over-http)).

The server reads `HOST` (default `127.0.0.1`), `PORT` (default 3000) and `PUBLIC_URL`, the address it tells OAuth clients it is at; the CLI reads `NOTES_URL` and `NOTES_TOKEN`. Change the port and set `PORT`, `PUBLIC_URL` and `NOTES_URL` to match. Every command asks for `NOTES_TOKEN`, the public `get-status` included: without it a command prints one message on stderr saying to set it, and exits 1. `--help` needs none.

## Retry a creation

`createNote({ title, body })` creates a new note on every call. To retry safely, add an optional `requestId`. Generate it once for a new creation, for example with `crypto.randomUUID()`, and keep it with the pending operation outside any retry loop. After a lost response, send the same key and content again. For the CLI, pass `--request-id` and keep it when repeating the command:

```sh
echo "First draft" | node --import tsx examples/notes-service/src/cli.ts create-note --request-id plan-1 --title Plan
```

What a key promises, per caller, for changed content and after the note changes, is what [test/notes/idempotency.test.ts](test/notes/idempotency.test.ts) asserts.

## Layout

```text
src/
├── notes/
│   ├── Notes.ts       contract: schemas, errors, actions
│   ├── store.ts       NoteStore, the service the handlers call, and its Layer
│   └── handlers.ts    Action.implement: contract to store
├── identity/
│   ├── Identity.ts    contract: CurrentUser, scopes, the Login descriptor, whoAmI
│   ├── authorize.ts   the one authorization rule
│   ├── users.ts       the demo users
│   ├── verifier.ts    Authentication.layer: tokens to users, server only
│   └── handlers.ts
├── status/
│   ├── Status.ts      contract: a public action
│   └── handlers.ts
├── Api.ts             the HTTP binding of every domain's actions
├── routes.ts          every surface of the host: /api, /mcp, /healthz, the OpenAPI document
├── server.ts          entrypoint: the HTTP server
├── worker.ts          entrypoint: a fetch handler for a serverless host
├── stdio.ts           entrypoint: MCP for a local agent
├── commands.ts        the commands calling the server, two written by hand, and their connection
├── cli.ts             entrypoint: the commands
└── browser.ts         client module: promises for a web page
test/
├── notes/             in process, with Action.client
├── routes.test.ts     over HTTP and MCP in memory, with Testing.layer
├── worker.test.ts     the worker's own fetch handler, with Testing.layer
└── commands.test.ts   the commands and their connection, against the same routes in memory
```

## Where to look

| To see | Read |
| --- | --- |
| A contract with declared errors and their statuses | `src/notes/Notes.ts` |
| Input fields described, for `--help` and a tool's schema | `src/notes/Notes.ts` |
| Handlers getting a service once and the caller per call | `src/notes/handlers.ts` |
| A write safe to retry with the same caller and request key | `src/notes/store.ts` |
| A public action beside protected ones | `src/status/` |
| Authorization from `readOnly`, refusing with a scope | `src/identity/authorize.ts` |
| A token verifier and OAuth discovery read from config | `src/identity/verifier.ts` |
| One implementation served over HTTP and MCP | `src/routes.ts` |
| Config, a body limit and the host's own routes | `src/server.ts`, `src/routes.ts` |
| The same actions over stdio, the host naming the caller | `src/stdio.ts` |
| A serverless entrypoint, the MCP endpoint `requestScoped` | `src/worker.ts`, `src/routes.ts` |
| A CLI derived from the binding: an argument, a field on stdin | `src/commands.ts` |
| A command written by hand beside the derived ones | `src/commands.ts` |
| A bulk import as one action, its command reading a file | `src/notes/`, `src/commands.ts` |
| The CLI's connection, read from config when a command runs | `src/commands.ts` |
| A missing token as one message, not a `ConfigError` report | `src/commands.ts` |
| A promise client handling a declared error by its tag | `src/browser.ts` |
| Testing handlers and authorization with no transport | `test/notes/in-process.test.ts` |
| Testing a revision race, two fibers taking turns | `test/notes/notes.test.ts` |
| Testing routes, tools and refusals in memory | `test/routes.test.ts` |
| Testing commands against the routes in memory | `test/commands.test.ts` |
| Testing `--help` and the connection with config as a Layer | `test/commands.test.ts` |
