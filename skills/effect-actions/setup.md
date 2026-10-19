# Setup

Install the package, import its modules, write the smallest program, lay out an application and
bundle a browser client.

Read this page alone, in one tool call; if its output says it was truncated, read it again alone.
When something fails, search [setup-failures.md](setup-failures.md). Reading order:
[SKILL.md](SKILL.md).

## Install

```sh
pnpm add @gjermundgaraba/effect-actions effect@~4.0.4
```

| Need                                | Add                                                             |
| ----------------------------------- | --------------------------------------------------------------- |
| Node HTTP server, stdio host or CLI | `@effect/platform-node@~4.0.4`                                  |
| Tests                               | `vitest@^5` and `@effect/vitest@~4.0.4`, as dev dependencies    |
| Type checking                       | `typescript@^7.0.2`, as a dev dependency                        |
| Running a TypeScript entrypoint     | `tsx`, as a dev dependency: `node --import tsx <entrypoint>.ts` |

The `effect` peer admits the 4.0.x patches from the oldest whose APIs the package uses, and no
minor release: a minor release may change the unstable Effect modules the surfaces build on.

Keep the tilde in `package.json`: `^4.0.4`, which npm writes for `effect@4.0.4`, admits a minor
release outside the peer range. `npm install effect@~4.0.4` keeps it.

Node `^22.12.0 || ^24.0.0 || >=26.0.0`: the package's `engines`, where its `devEngines` is
what developing the library itself takes. TypeScript 7 or newer. ESM only. No example ships a
`tsconfig.json`; this one checks them. The package's modules resolve only through its
`exports`, which `"module": "nodenext"` reads, as a bundler project's
`"moduleResolution": "bundler"` does. `"strict": true` is required, by Effect:

```json
{
  "compilerOptions": {
    "target": "es2023",
    "module": "nodenext",
    "strict": true,
    "exactOptionalPropertyTypes": true,
    "noEmit": true,
    "skipLibCheck": true
  },
  "include": ["src", "test"]
}
```

## Entry points

There is no package root. Import one module per subpath, as a namespace,
`import * as Action from "@gjermundgaraba/effect-actions/Action"`.
The modules: `Action`, `ActionHttp`, `ActionMcp`, `ActionRpc`, `ActionToolkit`, `ActionCli`,
`Authentication`, `Testing`.

Effect's own modules are subpaths of `effect` too: `effect/http` (`HttpRouter`, `HttpClient`,
`FetchHttpClient`), `effect/http-api` (`OpenApi`, `HttpApiMiddleware`), `effect/rpc`
(`RpcServer`, `RpcClient`), `effect/ai` (`LanguageModel`, `Chat`), `effect/cli` (`Command`) and
`effect/socket` (`Socket`).

## Minimal program

One action, served as a JSON route and as an MCP tool: four declarations, each in a file of
[quickstart/src/](node_modules/@gjermundgaraba/effect-actions/examples/quickstart/src/).

```ts
// greeting/Greeting.ts: the contract. It imports no server code.
export const Greet = Action.make("greet", {
  description: "Greet someone by name.",
  input: { name: Schema.String },
  success: Schema.String,
  readOnly: true,
  caller: Action.Anyone,
});

// greeting/handlers.ts: the implementation. Every surface takes this one value.
export const greeting = Action.implement(Greet, ({ name }) => Effect.succeed(`Hello, ${name}!`));

// Api.ts: the HTTP binding, which the server serves and the client calls.
export const Http = ActionHttp.make([Greet]);

// routes.ts: the surfaces as one Layer.
export const routes = Layer.mergeAll(
  ActionHttp.layer(Http, greeting),
  ActionMcp.layerHttp(greeting, { name: "greetings", version: "1.0.0" }),
);
```

Serve `routes` with `HttpRouter.serve` and a platform server layer
([quickstart/src/server.ts](node_modules/@gjermundgaraba/effect-actions/examples/quickstart/src/server.ts)) and you have `POST /api/greet`
and an MCP tool `greet` at `/mcp`. Call the route with the binding's typed client
([quickstart/src/client.ts](node_modules/@gjermundgaraba/effect-actions/examples/quickstart/src/client.ts)), and test both in memory
([quickstart/test/greeting/greeting.test.ts](node_modules/@gjermundgaraba/effect-actions/examples/quickstart/test/greeting/greeting.test.ts)).

A request body has no size limit unless the host sets one
([ActionHttp.md](ActionHttp.md#serve-the-routes)).
[notes-service](node_modules/@gjermundgaraba/effect-actions/examples/notes-service/) is this program grown into a service, in the same
layout.

## Lay out an application

Folders are domains; the PascalCase file in each is its contract file, which imports no server
code; `routes.ts` holds the surfaces; each entrypoint chooses the services. An entrypoint of a
remote surface never provides an identity: authentication supplies it per request
([Action.md](Action.md#say-who-may-call-an-action)). The tree:
[examples/README.md](node_modules/@gjermundgaraba/effect-actions/examples/README.md#how-they-are-laid-out).

## Bundle for a browser

Import into the page only the contract files, the binding and a client module of your own:
[notes-service/src/browser.ts](node_modules/@gjermundgaraba/effect-actions/examples/notes-service/src/browser.ts) over HTTP, with
promises, [live-rpc/src/browser.ts](node_modules/@gjermundgaraba/effect-actions/examples/live-rpc/src/browser.ts) over a WebSocket.

- `Action`, `ActionHttp`, `ActionRpc` and `Authentication` are the browser-safe modules: they
  use nothing of Node or a server platform.
- Keep `Action.implement` and `Authentication.layer` out of every file the page imports: a
  bundler keeps such a call, and what its handlers or verifier import, even unused.
- Those four modules import Effect through `effect`, `effect/http` and `effect/http-api` alone,
  and `ActionRpc` through `effect/rpc` too. A page loading Effect from an import map serves
  those, and `effect/socket` for a WebSocket client.
- A page on another origin needs CORS on the host, answered before authentication:
  `HttpRouter.cors`, as in
  [kitchen-sink/src/request-policy.ts](node_modules/@gjermundgaraba/effect-actions/examples/kitchen-sink/src/request-policy.ts).
