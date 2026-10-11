# Setup

Install the package, import its modules, write the smallest program, lay out an application and
bundle a browser client.

New here? Start at [README.md](README.md).

## Install

```sh
pnpm add @gjermundgaraba/effect-actions effect@~4.0.2
```

| Need                                | Add                                                              |
| ----------------------------------- | ---------------------------------------------------------------- |
| Node HTTP server, stdio host or CLI | `@effect/platform-node@~4.0.2`                                   |
| Tests                               | `vitest@^5.0.3` and `@effect/vitest@~4.0.2`, as dev dependencies |
| Type checking                       | `typescript@^7.0.2`, as a dev dependency                         |

The `effect` peer admits only the patches of the Effect release the package is tested against:
a minor release may change the unstable Effect modules the surfaces build on.

Keep the tilde in `package.json`: `^4.0.2`, which npm writes for `effect@4.0.2`, admits a minor
release outside the peer range. `npm install effect@~4.0.2` keeps it.

Node `^22.12.0 || ^24.0.0 || >=26.0.0`. TypeScript 7 or newer. ESM only. `tsconfig.json` sets
`"module": "nodenext"`, since the package's modules resolve only through its `exports`, and
`"strict": true`, which Effect requires.

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

Effect's own modules are subpaths of `effect` too: `effect/http` (`HttpRouter`, `HttpClient`,
`FetchHttpClient`), `effect/http-api` (`OpenApi`, `HttpApiMiddleware`), `effect/rpc`
(`RpcServer`, `RpcClient`), `effect/ai` (`LanguageModel`, `Chat`), `effect/cli` (`Command`) and
`effect/socket` (`Socket`).

## Minimal program

One action, served as a JSON route and as an MCP tool: four declarations, each in a file of
[quickstart/src/](../examples/quickstart/src/).

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

A request body has no size limit unless the host sets one
([ActionHttp.md](ActionHttp.md#serve-the-routes)).
[notes-service](../examples/notes-service/) is this program grown into a service, in the same
layout.

## Lay out an application

Folders are domains; the PascalCase file in each is its contract file, which imports no server
code; `routes.ts` holds the surfaces; each entrypoint chooses the services. An entrypoint of a
remote surface never provides an identity: authentication supplies it per request
([Action.md](Action.md#say-who-may-call-an-action)). The tree:
[examples/README.md](../examples/README.md#how-they-are-laid-out).

## Bundle for a browser

Import into the page only the contract files, the binding and a client module of your own:
[notes-service/src/browser.ts](../examples/notes-service/src/browser.ts) over HTTP, with
promises, [live-rpc/src/browser.ts](../examples/live-rpc/src/browser.ts) over a WebSocket.

- `Action`, `ActionHttp`, `ActionRpc` and `Authentication` are the browser-safe modules: they
  use nothing of Node or a server platform.
- Keep `Action.implement` and `Authentication.layer` out of every file the page imports: a
  bundler keeps such a call, and what its handlers or verifier import, even unused.
- Those four modules import Effect through `effect`, `effect/http` and `effect/http-api` alone,
  and `ActionRpc` through `effect/rpc` too. A page loading Effect from an import map serves
  those, and `effect/socket` for a WebSocket client.
- A page on another origin needs CORS on the host, answered before authentication:
  `HttpRouter.cors`, as in
  [kitchen-sink/src/request-policy.ts](../examples/kitchen-sink/src/request-policy.ts).
