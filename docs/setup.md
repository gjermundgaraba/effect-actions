# Setup

Install the package, import its modules, write the smallest program, lay out an application and
bundle a browser client.

## Install

```sh
pnpm add @gjermundgaraba/effect-actions effect@~4.0.2
```

| Need                                | Add                            |
| ----------------------------------- | ------------------------------ |
| Node HTTP server, stdio host or CLI | `@effect/platform-node@~4.0.2` |

The `effect` peer admits only the patches of the Effect release the package is tested against:
Effect marks the HTTP, HTTP API, RPC, AI and CLI modules the surfaces build on unstable, so a
minor release may change them.

Node `^22.12.0 || ^24.0.0 || >=26.0.0`. TypeScript 7 or newer. ESM only.

## Entry points

There is no package root. Import one module per subpath, as a namespace:

```ts
import * as Action from "@gjermundgaraba/effect-actions/Action";
import * as ActionHttp from "@gjermundgaraba/effect-actions/ActionHttp";
import * as ActionMcp from "@gjermundgaraba/effect-actions/ActionMcp";
import * as ActionRpc from "@gjermundgaraba/effect-actions/ActionRpc";
import * as ActionToolkit from "@gjermundgaraba/effect-actions/ActionToolkit";
import * as ActionCli from "@gjermundgaraba/effect-actions/ActionCli";
import * as Authentication from "@gjermundgaraba/effect-actions/Authentication";
import * as Testing from "@gjermundgaraba/effect-actions/Testing";
```

Every module imports from the `effect` package only. Importing `Action` or `ActionHttp` never
pulls in an MCP server or the AI toolkit.

Effect's own modules are subpaths of `effect` too: `effect/http` (`HttpRouter`, `HttpClient`,
`FetchHttpClient`), `effect/http-api` (`OpenApi`, `HttpApiMiddleware`), `effect/rpc`
(`RpcServer`, `RpcClient`), `effect/ai` (`LanguageModel`, `Chat`), `effect/cli` (`Command`) and
`effect/socket` (`Socket`).

## Minimal program

One action, served as a JSON route and as an MCP tool. Its four declarations, each in a file of
its own:

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
([quickstart/src/server.ts](../examples/quickstart/src/server.ts)) and you have `POST /api/greet`
and an MCP tool `greet` at `/mcp`. Call the route with the binding's typed client
([quickstart/src/client.ts](../examples/quickstart/src/client.ts)), and test both in memory
([quickstart/test/greeting/greeting.test.ts](../examples/quickstart/test/greeting/greeting.test.ts)).
Each declaration is a file of [quickstart/src/](../examples/quickstart/src/).

A request body has no size limit unless the host sets one
([ActionHttp.md](ActionHttp.md#serve-the-routes)).
[notes-service](../examples/notes-service/) is this program grown into a service, in the same
layout.

## Lay out an application

Folders are domains; the PascalCase file in each is its contract file, which imports no server
code; `routes.ts` holds the surfaces; each entrypoint chooses the services. An entrypoint of a
remote surface never provides an identity: authentication supplies it per request
([Action.md](Action.md#say-who-may-call-an-action)). The tree and the reasons:
[examples/README.md](../examples/README.md#how-they-are-laid-out).

## Bundle for a browser

A page calls the server with `ActionHttp.client`, with `ActionHttp.fetchClient` outside an
Effect, or with `ActionRpc.client`. Import into the page only the contract files, the binding
and a client module of your own:
[notes-service/src/browser.ts](../examples/notes-service/src/browser.ts) over HTTP, with
promises, [live-rpc/src/browser.ts](../examples/live-rpc/src/browser.ts) over a WebSocket.

- `Action`, `ActionHttp`, `ActionRpc` and `Authentication` are the browser-safe modules: they
  and what they import use nothing of Node or a server platform.
- Keep `Action.implement` and `Authentication.layer` out of every file the page imports: a
  bundler keeps such a call, and what its handlers or verifier import, even unused.
- Those four modules import Effect through `effect`, `effect/http` and `effect/http-api` alone,
  and `ActionRpc` through `effect/rpc` too. A page loading Effect from an import map serves
  those, and `effect/socket` for a WebSocket client.
- A page on another origin needs CORS on the host, answered before authentication:
  `HttpRouter.cors`, as in
  [kitchen-sink/src/request-policy.ts](../examples/kitchen-sink/src/request-policy.ts).

## Failure modes

- `Cannot find module '@gjermundgaraba/effect-actions'`: there is no root export. Import a subpath from [Entry points](#entry-points), never the root or a `dist/` path.
- A browser build fails with `Could not resolve "node:…"`, or warns `Module "node:…" has been externalized for browser compatibility`: the page imports a file that also holds server code, such as a contract beside its `Action.implement`, or an authentication descriptor beside its `Authentication.layer`. Move contracts, identities, descriptors and bindings to files that import no server code.
- A page that loads Effect from an import map still bundles a second copy of Effect, or of some of its modules: a module of the page imports an Effect specifier the map does not serve, such as `effect/Schema`. Serve the specifiers [Bundle for a browser](#bundle-for-a-browser) lists, and import Effect through them in the page's own modules too. With a bundler that externalizes subpaths too, such as esbuild's `--external:effect`, the page instead fails to resolve `effect/Schema` in the browser.
- A page loading Effect from an import map fails before its modules run, with `Failed to resolve module specifier "effect/Cause"` in Chromium: the map points at Effect's published files and lacks a specifier Effect imports itself. Map `effect/Cause`, `effect/Effect`, `effect/Exit` and `effect/Function` to the same files, or serve Effect from a build that resolves its own imports.
- A page fails at load with `does not provide an export named …`: it serves only the names it uses of an Effect specifier, from a vendored module or a trimmed bundle, and the package imports another, as a release may. Serve each specifier whole.
- Type errors inside `effect/*` modules after install, or an unmet peer warning for `effect`, such as `found 4.1.0`: more than one Effect release is installed, or one outside the peer range. Install the `effect` range [Install](#install) names, with every `@effect/*` package on the same release.
- `Cannot find module 'effect/unstable/http'` (or `…/httpapi`, `…/cli`, `…/ai`): these modules moved to `effect/http`, `effect/http-api`, `effect/cli` and `effect/ai`. Import the new paths.
