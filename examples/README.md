# Examples

Complete applications built with `@gjermundgaraba/effect-actions`. Each is a directory you can
run, with its own tests and a README that says what it shows and where. They are type-checked,
linted and tested with the library, and they ship in the package, at
`node_modules/@gjermundgaraba/effect-actions/examples`.

| Example                         | What it is                                                                                                       | Start from it when                                                      |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| [quickstart](quickstart/)       | One action, served as a JSON route and an MCP tool, called with its typed client.                                | You want the smallest thing that runs.                                  |
| [notes-service](notes-service/) | A service with bearer authentication: a JSON API and MCP tools from one implementation, a CLI, a browser client. | You are building a service others call. Most applications are this.     |
| [mcp-tools](mcp-tools/)         | An MCP server whose tools wrap an upstream HTTP API, over stdio and over HTTP, with an image result.             | You are putting an existing API in front of a model.                    |
| [assistant](assistant/)         | No server: the same implementations as a model's tools, with approval of writes, and as local commands.          | A model calls your code in process, or you are building a local CLI.    |
| [live-rpc](live-rpc/)           | Effect RPC over a WebSocket with a browser-shaped client, each message carrying its own token.                   | A client keeps a connection open, or the application speaks Effect RPC. |
| [kitchen-sink](kitchen-sink/)   | The reference: a multi-tenant issue tracker using every module and nearly every option, with an index.           | You need a working use of one specific feature.                         |

## Run one

From the repository root, after `vp install`, each README's commands work as written, for
example:

```sh
node --import tsx examples/notes-service/src/server.ts
vp test examples/notes-service
```

In a project that installs the package, copy an example's directory out of `node_modules` and
run it the same way: the examples import the package by its name. They need `tsx` and
`@effect/platform-node` beside `effect`, and `vitest` with `@effect/vitest` for their tests.

## How they are laid out

Every example follows one layout, which is the one we recommend for an application. Each has
the parts of it that it needs:

```text
<example>/
├── src/
│   ├── <domain>/
│   │   ├── <Domain>.ts    the contract: schemas, errors, actions
│   │   ├── <service>.ts   a service and its Layer
│   │   └── handlers.ts    the implementation: contract to service
│   ├── Api.ts, Rpc.ts     the bindings, where a surface has one
│   ├── routes.ts          the host's remote surfaces as Layers, where it serves any
│   └── server.ts …        one entrypoint per way of running it
└── test/
    ├── <domain>/          what the domain does
    └── routes.test.ts     what the surfaces add, called in memory
```

- **Folders are domains, not mechanisms.** Everything about notes is in `notes/`; there is no
  `contracts/`, `handlers/` or `tools/` folder.
- **The PascalCase file in a domain is its contract.** It imports no server code, so a browser
  or a CLI can import it. Lowercase files beside it run on the server, each named for its role
  (`handlers.ts`, `store.ts`), never for the domain: `notes.ts` beside `Notes.ts` is one file on
  a disk that ignores case.
- **An entrypoint is where implementations are chosen**: which store, which platform, and on a
  local surface which caller. Nothing below it knows what it got, so a test chooses its own.
- **Tests mirror the source.** A domain's tests sit in `test/<domain>/`, most calling its
  implementation in process with `Action.client`; a test of a root file, such as `routes.ts`,
  sits beside them and calls the real routes in memory with `Testing.layer`. None opens a port.

In a monorepo, the contract files and the binding are the package that the server, the CLI and
the website all depend on; the rest is the server.

Every token, user and store in these examples is a demo. Each place that must change before a
deployment is marked `DEMO ONLY`.
