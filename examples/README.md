# Examples

Complete applications built with `@gjermundgaraba/effect-actions`. Each is a directory you can run, with its own tests and a README that says what it shows and where. They are type-checked, linted and tested with the library, and they ship in the package, at `node_modules/@gjermundgaraba/effect-actions/examples`.

[quickstart](quickstart/), [notes-service](notes-service/), [mcp-tools](mcp-tools/), [assistant](assistant/), [live-rpc](live-rpc/), [build-events](build-events/) and [kitchen-sink](kitchen-sink/): which to start from, by what you are building, is the table in [docs/README.md](../docs/README.md#examples).

## Run one

From the repository root, after `vp install`, each README's commands work as written, for example:

```sh
node --import tsx examples/notes-service/src/server.ts
vp test examples/notes-service
```

In a project that installs the package, copy an example's directory out of `node_modules` and run it the same way: the examples import the package by its name. They need `tsx`, `@effect/platform-node` and `@types/node` beside `effect`, and `vitest` with `@effect/vitest` for their tests.

## How they are laid out

Every example follows one layout, which is the one we recommend for an application. Each has the parts of it that it needs:

```text
<example>/
├── src/
│   ├── <domain>/
│   │   ├── <Domain>.ts    the contract: schemas, errors, actions
│   │   ├── <service>.ts   a service, its constructor and any in-memory Layer
│   │   └── handlers.ts    the implementation: contract to service
│   ├── platform/          a service's Layer over a database, a file or an upstream API
│   ├── Api.ts, Rpc.ts     the bindings, where a surface has one
│   ├── routes.ts          the host's remote surfaces as Layers, where it serves any
│   └── server.ts …        one entrypoint per way of running it
└── test/
    ├── <domain>/          what the domain does
    ├── platform/          an adapter, against a stand-in for what it reaches
    └── routes.test.ts     what the surfaces add, called in memory
```

- **Folders are domains, not mechanisms.** Everything about notes is in `notes/`; there is no `contracts/`, `handlers/` or `tools/` folder. `platform/`, the adapters, is the one exception.
- **The PascalCase file in a domain is its contract.** It imports no server code, so a browser or a CLI can import it. Lowercase files beside it run on the server, each named for its role (`handlers.ts`, `store.ts`), never for the domain: `notes.ts` beside `Notes.ts` is one file on a disk that ignores case.
- **Technology stays out of domains.** A domain's service declares what its handlers need; a Layer that reaches a file system, a database or another service's API is an adapter, in `platform/`, named for what it reaches (`tasks-file.ts`, `print-farm.ts`), and turns that technology's failures into the domain's declared errors, or into defects where no caller can act on them. A Layer in memory, which reaches nothing, stays beside its service.
- **An entrypoint is where implementations are chosen**: which store, which platform, and on a local surface which caller. Nothing below it knows what it got, so a test chooses its own.
- **Tests mirror the source.** A domain's tests sit in `test/<domain>/`, most calling its implementation in process with `Action.client`; a test of a root file, such as `routes.ts`, sits beside them and calls the real routes in memory with `Testing.layer`. One opens a port: live-rpc's `server.test.ts`, for the WebSocket no in-memory test reaches.

In a monorepo, the contract files and the binding are the package that the server, the CLI and the website all depend on; the rest is the server.

Every token, user and store in these examples is a demo. Each place that must change before a deployment is marked `DEMO ONLY`.
