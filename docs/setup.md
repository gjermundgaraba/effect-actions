# Setup

Install the package, import its modules, write the smallest program, lay out an application and
bundle a browser client.

A message the library throws says its fix; for a compiler diagnostic or Effect's own error, search [setup-failures.md](setup-failures.md).

## Install

```sh
pnpm add @gjermundgaraba/effect-actions effect@~4.0.4
```

| Need                                | Add                                                             |
| ----------------------------------- | --------------------------------------------------------------- |
| Node HTTP server, stdio host or CLI | `@effect/platform-node@~4.0.4`                                  |
| Tests                               | `vitest@^5` and `@effect/vitest@~4.0.4`, as dev dependencies    |
| Type checking                       | `typescript@^7.0.2`, as a dev dependency                        |
| Node's types, for `node:` imports   | `@types/node`, as a dev dependency                              |
| Running a TypeScript entrypoint     | `tsx`, as a dev dependency: `node --import tsx <entrypoint>.ts` |

The `effect` peer admits the 4.0.x patches from the oldest whose APIs the package uses, and no
minor release: a minor release may change the unstable Effect modules the surfaces build on.

Keep the tilde in `package.json`: `^4.0.4`, which npm writes for `effect@4.0.4`, admits a minor
release outside the peer range. `npm install effect@~4.0.4` keeps it.

Node `>=26`: the package's `engines`, the Node the library is developed and tested on. TypeScript 7 or newer. ESM only. The repository checks the
examples with a stricter `tsconfig.json`; this is the minimum a project needs. The package's modules resolve only through its
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
    "skipLibCheck": true,
    "types": ["node"]
  },
  "include": ["src", "test"]
}
```

## Entry points

There is no package root. Import one module per subpath, as a namespace,
`import * as Action from "@gjermundgaraba/effect-actions/Action"`.
The modules: `Action`, `Event`, `ActionHttp`, `ActionMcp`, `ActionRpc`, `ActionToolkit`,
`ActionCli`, `Authentication`, `Testing`.

Effect's own modules are subpaths of `effect` too: `effect/http` (`HttpRouter`, `HttpClient`,
`FetchHttpClient`), `effect/http-api` (`OpenApi`, `HttpApiMiddleware`), `effect/rpc`
(`RpcServer`, `RpcClient`), `effect/ai` (`LanguageModel`, `Chat`), `effect/cli` (`Command`) and
`effect/socket` (`Socket`).

## Minimal program

One action, served as a JSON route and as an MCP tool: four declarations, each in a file of
[quickstart/src/](../examples/quickstart/src/).

```ts example=quickstart/src/greeting/Greeting.ts
import { Schema } from "effect";
import * as Action from "@gjermundgaraba/effect-actions/Action";

// A contract: what the action takes and answers, whether it changes anything, and who may
// call it. It imports no server code, so any client can import it, a browser page included.
export const Greet = Action.make("greet", {
  description: "Greet someone by name.",
  input: { name: Schema.String },
  success: Schema.String,
  readOnly: true,
  caller: Action.Anyone,
});
```

```ts example=quickstart/src/greeting/handlers.ts
import { Effect } from "effect";
import * as Action from "@gjermundgaraba/effect-actions/Action";
import { Greet } from "./Greeting.js";

// The implementation: the contract bound to its handler. Every surface takes this one value.
export const greeting = Action.implement(Greet, ({ name }) => Effect.succeed(`Hello, ${name}!`));
```

```ts example=quickstart/src/Api.ts
import * as ActionHttp from "@gjermundgaraba/effect-actions/ActionHttp";
import { Greet } from "./greeting/Greeting.js";

// The HTTP binding: `POST /api/greet`. The server serves it and the client calls it.
export const Http = ActionHttp.make([Greet]);
```

```ts example=quickstart/src/routes.ts
import { Layer } from "effect";
import * as ActionHttp from "@gjermundgaraba/effect-actions/ActionHttp";
import * as ActionMcp from "@gjermundgaraba/effect-actions/ActionMcp";
import { Http } from "./Api.js";
import { greeting } from "./greeting/handlers.js";

// One implementation, two surfaces: a JSON route and an MCP tool at `/mcp`.
export const routes = Layer.mergeAll(
  ActionHttp.layer(Http, greeting),
  ActionMcp.layerHttp(greeting, { name: "greetings", version: "1.0.0" }),
);
```

Serve `routes` with `HttpRouter.serve` and a platform server layer
([quickstart/src/server.ts](../examples/quickstart/src/server.ts)), call the route with the
binding's typed client ([quickstart/src/client.ts](../examples/quickstart/src/client.ts)), and
test both in memory ([quickstart/test/routes.test.ts](../examples/quickstart/test/routes.test.ts)).
[notes-service](../examples/notes-service/) is this program grown into a service, in the same
layout.

## Lay out an application

Copy the examples' layout:
[examples/README.md](../examples/README.md#how-they-are-laid-out).

## Bundle for a browser

Import into the page only the contract files, the binding and a client module of your own:
[notes-service/src/browser.ts](../examples/notes-service/src/browser.ts) over HTTP, with
promises, [live-rpc/src/browser.ts](../examples/live-rpc/src/browser.ts) over a WebSocket.

- `Action`, `Event`, `ActionHttp`, `ActionRpc` and `Authentication` are the browser-safe modules: they
  use nothing of Node or a server platform.
- Keep `Action.implement` and `Authentication.layer` out of every file the page imports: a
  bundler keeps such a call, and what its handlers or verifier import, even unused.
- Those five modules import Effect through `effect`, `effect/http` and `effect/http-api` alone,
  and `ActionRpc` through `effect/rpc` too. A page loading Effect from an import map serves
  those, and `effect/socket` for a WebSocket client.
