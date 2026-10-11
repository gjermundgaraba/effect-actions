# notes-service

A small service as most applications of this library are built: one set of contracts, one
implementation, served as a JSON API and as MCP tools, with a CLI and a browser client on the
same binding. Notes belong to the signed-in user; reading needs the `notes:read` scope and
writing `notes:write`.

Start here if you are building a service. The other examples follow the same layout.

## Run it

From the repository root, after `vp install` (from an installed package, see
[Run one](../README.md#run-one)):

```sh
node --import tsx examples/notes-service/src/server.ts          # 127.0.0.1:3000

export NOTES_TOKEN=ada                                          # a demo token: ada, grace or reader
node --import tsx examples/notes-service/src/cli.ts --help
echo "First draft" | node --import tsx examples/notes-service/src/cli.ts create-note --title Plan
node --import tsx examples/notes-service/src/cli.ts list-notes
node --import tsx examples/notes-service/src/cli.ts export notes.md   # a command written by hand

vp test examples/notes-service
```

An agent host connects to the running server, and so to the notes the API holds:

```sh
claude mcp add --transport http notes http://127.0.0.1:3000/mcp --header "Authorization: Bearer ada"
codex mcp add notes --url http://127.0.0.1:3000/mcp --bearer-token-env-var NOTES_TOKEN
```

`src/stdio.ts` is the other way in: a subprocess the host starts, with a store of its own.

The server reads `PORT` (default 3000) and `PUBLIC_URL`, the address it tells OAuth clients it
is at; the CLI reads `NOTES_URL` and `NOTES_TOKEN`. Change the port and set all three to match.

The tokens are fixed names and the store is memory: replace both before deploying anything.

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
├── stdio.ts           entrypoint: MCP for a local agent
├── commands.ts        the commands calling the server, one of them written by hand
├── cli.ts             entrypoint: the commands, connected from config
└── browser.ts         client module: promises for a web page
test/
├── notes/             in process, with Action.client
├── routes.test.ts     over HTTP and MCP in memory, with Testing.layer
└── commands.test.ts   the commands, against the same routes in memory
```

- **A folder per domain, not per mechanism.** Everything about notes is in `notes/`; there is no
  `contracts/` or `handlers/` folder.
- **The PascalCase file is the contract.** `Notes.ts`, `Identity.ts`, `Status.ts` and `Api.ts`
  import no server code, so a browser or a CLI imports them. The lowercase files beside them run
  on the server.
- **One entrypoint per way of running it.** Each chooses its own implementations: `server.ts`
  picks the store and the HTTP server, `stdio.ts` names the local user, a test provides its own
  store. Nothing below an entrypoint knows which it got.
- **In a monorepo** the contract files and `Api.ts` are the package the server, the CLI and the
  website all depend on; the lowercase files and `routes.ts` are the server.

## Where to look

| To see                                                        | Read                             |
| ------------------------------------------------------------- | -------------------------------- |
| A contract with declared errors and their statuses            | `src/notes/Notes.ts`             |
| Handlers getting a service once and the caller per call       | `src/notes/handlers.ts`          |
| A public action beside protected ones                         | `src/status/`                    |
| Authorization from `readOnly`, refusing with a scope          | `src/identity/authorize.ts`      |
| A token verifier and OAuth discovery read from config         | `src/identity/verifier.ts`       |
| One implementation served over HTTP and MCP                   | `src/routes.ts`                  |
| Config, a body limit and the host's own routes                | `src/server.ts`, `src/routes.ts` |
| The same actions over stdio, the host naming the caller       | `src/stdio.ts`                   |
| A CLI derived from the binding: an argument, a field on stdin | `src/commands.ts`                |
| A command written by hand beside the derived ones             | `src/commands.ts`                |
| The CLI's connection, read from config                        | `src/cli.ts`                     |
| A promise client handling each declared error by its tag      | `src/browser.ts`                 |
| Testing handlers and authorization with no transport          | `test/notes/notes.test.ts`       |
| Testing routes, tools and refusals in memory                  | `test/routes.test.ts`            |
| Testing commands against the routes in memory                 | `test/commands.test.ts`          |
