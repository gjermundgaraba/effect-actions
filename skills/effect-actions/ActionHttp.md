# ActionHttp

JSON `POST` routes on Effect's `HttpApi`, one per action. `ActionHttp.make` binds actions to a
mount path; the server mounts that one binding, every client calls it and the OpenAPI document is
generated from it.

A message the library throws says its fix; for a compiler diagnostic or Effect's own error, search
[ActionHttp-failures.md](ActionHttp-failures.md). For one symbol,
`grep -rn <symbol> node_modules/@gjermundgaraba/effect-actions/dist/`: each declaration's JSDoc
carries its rules and gotchas, and this page only what an example cannot show.

## Bind actions to routes

Call `ActionHttp.make` once, in a contract-only file, and export the binding:

```ts example=notes-service/src/Api.ts
import * as ActionHttp from "@gjermundgaraba/effect-actions/ActionHttp";
import { Login, WhoAmI } from "./identity/Identity.js";
import { Notes } from "./notes/Notes.js";
import { GetStatus } from "./status/Status.js";

// The HTTP binding: every action at `POST /api/<name>`, the protected ones requiring `Login`.
// It is plain data and imports no server code, so the server, the CLI and a browser page all
// import this one value, and each gets its routes or its typed methods from it. An action
// added here is also a `notes` command: commands.ts derives one per action of this binding.
export const Http = ActionHttp.make([GetStatus, ...Notes, WhoAmI], {
  prefix: "/api",
  authentication: Login,
});
```

[quickstart/src/Api.ts](node_modules/@gjermundgaraba/effect-actions/examples/quickstart/src/Api.ts) binds public actions with no options;
[kitchen-sink/src/Api.ts](node_modules/@gjermundgaraba/effect-actions/examples/kitchen-sink/src/Api.ts) gives `prefix` and `error` and makes
two bindings, one per identity. What every endpoint declares is on `ActionHttp.make`, the rules of
`prefix`, `error` and `authentication` on `ActionHttp.Options`, and a protected action's descriptor
in [Authentication.md](Authentication.md#declare-how-callers-sign-in).

## Serve the routes

Give `ActionHttp.layer` the binding and the implementations, merge it with the host's other
routes, provide the descriptor's provider
([Authentication.md](Authentication.md#verify-credentials)), and serve the result with
`HttpRouter.serve`.

```ts example=notes-service/src/routes.ts
import { Layer } from "effect";
import { HttpRouter, HttpServerResponse } from "effect/http";
import { OpenApi } from "effect/http-api";
import * as ActionHttp from "@gjermundgaraba/effect-actions/ActionHttp";
import * as ActionMcp from "@gjermundgaraba/effect-actions/ActionMcp";
import { Http } from "./Api.js";
import { identity } from "./identity/handlers.js";
import { Login } from "./identity/Identity.js";
import { authenticate } from "./identity/verifier.js";
import { notes } from "./notes/handlers.js";
import { status } from "./status/handlers.js";

// Every domain's implementation, once. Each surface below takes the same list.
const implementations = [status, notes, identity];

// JSON routes at `/api/<action>`, the binding's; `getStatus` answers anyone.
const api = ActionHttp.layer(Http, implementations);

// The host's own routes sit beside the actions' on the same router.
const health = HttpRouter.add("GET", "/healthz", HttpServerResponse.text("ok"));

// Served to anyone, which is a choice: it tells a signed-out caller every action's name and
// shape. To keep them, leave the route out, or provide `Authentication.protect(Login).layer`
// to it.
const openApi = HttpRouter.add(
  "GET",
  "/api/openapi.json",
  HttpServerResponse.jsonUnsafe(OpenApi.fromApi(Http.api)),
);

// What the host serves: the JSON routes, the same actions as MCP tools at `/mcp`, and the host's
// own routes. The MCP endpoint serves the public `getStatus` beside the protected tools, so a
// signed-out 2026-07-28 client may list the tools and call `getStatus`; what else needs a token
// is on `ActionMcp.LayerHttpOptions.authentication`. It still requires `NoteStore`: the
// entrypoint chooses which one, and a test chooses its own. The entrypoint also chooses how the
// MCP endpoint runs: one server for every request, or one per request.
const serving = (requestScoped: boolean) =>
  Layer.mergeAll(
    api,
    ActionMcp.layerHttp(implementations, {
      name: "notes-service",
      version: "1.0.0",
      instructions: "Notes belong to the signed-in user. Read a note before updating it.",
      authentication: Login,
      requestScoped,
    }),
    health,
    openApi,
  ).pipe(Layer.provide(authenticate));

export const routes = serving(false);

export const requestScopedRoutes = serving(true);
```

The smallest routes are [quickstart/src/routes.ts](node_modules/@gjermundgaraba/effect-actions/examples/quickstart/src/routes.ts). What
each route answers and what an `ErrorReporter` is given are on `ActionHttp.layer`.

The entrypoint serves the routes, with a request body limit; what that limit covers is on
`ActionHttp.layer`.

```ts example=notes-service/src/server.ts
import { createServer } from "node:http";
import { NodeHttpServer, NodeRuntime } from "@effect/platform-node";
import { ByteSize, Config, Effect, Layer } from "effect";
import { HttpRouter, HttpServerRequest } from "effect/http";
import { NoteStore } from "./notes/store.js";
import { routes } from "./routes.js";

// Entrypoint: `node --import tsx examples/notes-service/src/server.ts`.
// It chooses the store, reads the configuration and starts Node's HTTP server.
const server = Layer.unwrap(
  Effect.gen(function* () {
    // The loopback default serves this machine alone; HOST=0.0.0.0 lets others reach it.
    const host = yield* Config.String("HOST").pipe(Config.withDefault("127.0.0.1"));
    const port = yield* Config.Port("PORT").pipe(Config.withDefault(3000));

    return HttpRouter.serve(routes).pipe(
      Layer.provide(NodeHttpServer.layer(createServer, { host, port })),
      // Request bodies have no size limit unless the host sets one. This covers every route that
      // reads its body whole.
      Layer.provide(Layer.succeed(HttpServerRequest.MaxBodySize, ByteSize.mebibytes(1))),
      // DEMO ONLY: notes live in this process's memory; a deployment provides a store that lasts.
      Layer.provide(NoteStore.layerMemory),
    );
  }),
);

Layer.launch(server).pipe(NodeRuntime.runMain);
```

- A service a verifier, handler or authorizer reads per request is provided by router middleware
  around the layer
  ([kitchen-sink/src/workspaces/tenant.ts](node_modules/@gjermundgaraba/effect-actions/examples/kitchen-sink/src/workspaces/tenant.ts),
  read by the verifier, provided in
  [kitchen-sink/src/routes.ts](node_modules/@gjermundgaraba/effect-actions/examples/kitchen-sink/src/routes.ts)), or, for a handler or
  authorizer, by `ActionHttp.LayerOptions.middleware`; declaring it, and why not
  `HttpRouter.provideRequest`, are on `ActionHttp.layer`.

### Split a binding across layers, and add middleware

Serve each action from exactly one layer. Files:
[kitchen-sink/src/routes.ts](node_modules/@gjermundgaraba/effect-actions/examples/kitchen-sink/src/routes.ts) (`api`),
[kitchen-sink/src/identity/quota.ts](node_modules/@gjermundgaraba/effect-actions/examples/kitchen-sink/src/identity/quota.ts). Where a
check runs decides what it sees:

| Where                                                    | Runs                                     | Use it for                                                 |
| -------------------------------------------------------- | ---------------------------------------- | ---------------------------------------------------------- |
| Global router middleware                                 | before routing, on every route           | a Host or Origin policy, CORS                              |
| Router middleware provided to an `ActionHttp.layer` call | around its routes, before authentication | a per-request service; a limit on unauthenticated requests |
| `ActionHttp.LayerOptions.middleware`                     | after authentication, before decoding    | a limit keyed by the caller, counting invalid input too    |
| The handler ([Action.md](Action.md#authorize-calls))     | after decoding and the authorizer        | a limit that holds on every surface, MCP included          |

What router middleware answering with a binding error must send is on `ActionHttp.Options.error`.
A request policy that must run before authentication and OAuth discovery:
[Authentication-advanced.md](Authentication-advanced.md#run-a-request-policy-before-authentication).

### Publish the OpenAPI document

Give `Http.api`, a plain `HttpApi`, to `OpenApi.fromApi`, `HttpApiSwagger.layer` or
`HttpApiScalar.layer`, on routes of the host's own: `openApi` above,
[kitchen-sink/src/routes.ts](node_modules/@gjermundgaraba/effect-actions/examples/kitchen-sink/src/routes.ts) (`documentation`). What the
document holds and omits is on `ActionHttp.Binding.api`.

## Call the API from Effect

What a call fails with is on `ActionHttp.client`, and a token or a per-request sign-in goes
through `ActionHttp.ClientOptions.transformClient`.

```ts example=quickstart/src/client.ts
import { NodeRuntime } from "@effect/platform-node";
import { Console, Effect } from "effect";
import { FetchHttpClient } from "effect/http";
import * as ActionHttp from "@gjermundgaraba/effect-actions/ActionHttp";
import { Http } from "./Api.js";

// Entrypoint: `node --import tsx examples/quickstart/src/client.ts`, with the server running.
// One typed method per action of the binding.
// DEMO ONLY: a deployed client reads its `baseUrl` from configuration (kitchen-sink/src/seed.ts).
Effect.gen(function* () {
  const client = yield* ActionHttp.client(Http, { baseUrl: "http://127.0.0.1:3000" });

  yield* Console.log(yield* client.greet({ name: "Ada" }));
}).pipe(Effect.provide(FetchHttpClient.layer), NodeRuntime.runMain);
```

[kitchen-sink/src/seed.ts](node_modules/@gjermundgaraba/effect-actions/examples/kitchen-sink/src/seed.ts) reads `baseUrl` from `Config`,
sends headers and handles errors by tag. `ActionMcp.client` takes the same `transformClient`, and
`ActionCli.remote` the unyielded `ActionHttp.client(Http, …)` as its `client`.

- In a test, provide `Testing.layer(routes)` instead of a network client
  ([Testing.md](Testing.md#test-routes-in-memory),
  [notes-service/test/routes.test.ts](node_modules/@gjermundgaraba/effect-actions/examples/notes-service/test/routes.test.ts)).

## Serve and watch events

List [event types](Event.md) in the binding beside the actions, and their implementations in
`layer`'s list, and in its `actions` where it is given: each is served at
`POST <prefix>/events/<name>`, which answers a page of JSON, or
an SSE stream to a request that accepts `text/event-stream`. Experimental, as [events](Event.md) are.

```ts example=build-events/src/Api.ts
import * as ActionHttp from "@gjermundgaraba/effect-actions/ActionHttp";
import {
  BuildFinished,
  FinishBuild,
  PipelineStatus,
  StartBuild,
  TailLog,
} from "./builds/Builds.js";
import { DeployRequested, RequestDeploy } from "./deploys/Deploys.js";
import { Login } from "./identity/Identity.js";

// The HTTP binding: each action at `POST /api/<name>`, and each event at
// `POST /api/events/<name>`, which answers a page of JSON, or, asked for `text/event-stream`,
// holds a stream open. It imports no server code, so a client imports it with the contracts.
export const Http = ActionHttp.make(
  [FinishBuild, StartBuild, TailLog, BuildFinished, PipelineStatus, RequestDeploy, DeployRequested],
  { authentication: Login },
);
```

[build-events/src/routes.ts](node_modules/@gjermundgaraba/effect-actions/examples/build-events/src/routes.ts) serves the same
implementations over HTTP, MCP and RPC. A client of the binding has `watch(event, input, options)`, as
`Action.client`'s: [build-events/test/http.test.ts](node_modules/@gjermundgaraba/effect-actions/examples/build-events/test/http.test.ts)
watches by stream and by poll. What a route answers is on `layer`; what a watch fails with is on
`client`. A protected event's binding also has `/subscribe` and `/unsubscribe` routes, for
webhook delivery ([Webhook.md](Webhook.md)), which `make` says when it adds.

- **Not a browser `EventSource`.** It sends neither a JSON body nor a header credential, so a page
  watches with `fetchClient`, whose `watch` reads the stream through `fetch`.

- **Which deployment.** As over MCP, a log source and a `subscription` hook need one server that
  outlives a request.

## Serve what another server serves

`ActionHttp.placed(binding, client)` stands, in a surface's list of implementations, for the
binding's actions and event types where another server serves them, such as a Worker in front of
the Durable Object that holds the data: each call and subscription is sent on, with the caller's
headers, to the server `client` reaches for its input and its contract, which serves them in its own
`ActionHttp.layer` of the binding, and its answer is passed back. `ActionHttp.layer`,
`ActionMcp.layerHttp` and `ActionRpc.layer` take it beside their own implementations. Both servers
verify the credential, so both are given the verifier; the server reached authorizes. Its rules
are on `ActionHttp.placed`.

## Call the API from a browser

Code outside an Effect builds the client once with `ActionHttp.fetchClient` and runs each call
with `Effect.runPromise`. Files:
[notes-service/src/browser.ts](node_modules/@gjermundgaraba/effect-actions/examples/notes-service/src/browser.ts),
[kitchen-sink/src/sdk.ts](node_modules/@gjermundgaraba/effect-actions/examples/kitchen-sink/src/sdk.ts) (a `baseUrl`, two headers).

- A page on another origin needs the server to allow it with `HttpRouter.cors`; sending cookies
  from there is on `ActionHttp.FetchClientOptions.fetch`.
- Bundling the page: [setup.md](setup.md#bundle-for-a-browser).
