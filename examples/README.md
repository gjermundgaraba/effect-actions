# One action, two transports

Run `vp run example` from the repository root. See the [main README](../README.md#run-it) for curl commands and demo credentials.

## Read in this order

1. **[contracts.ts](contracts.ts)** — define input, success, and error schemas with `Action.make`; collect them with `ActionGroup.make`.
2. **[auth.ts](auth.ts)** — the application's identity model: `CurrentActor`, `Forbidden`, `Unauthenticated`, `authorize`. The library imports none of it.
3. **[handlers.ts](handlers.ts)** — implement the whole group with `Actions.implement`; `Users` is resolved once at build, `CurrentActor` per request.
4. **[app.ts](app.ts)** — project the implementation to HTTP and MCP, wrap both in authentication middleware, and supply `Users` once.
5. **[server.ts](server.ts)** — serve the native router with `NodeHttpServer`; let Effect manage shutdown.

[client.ts](client.ts) demonstrates typed action calls from a consumer; supply an Effect HTTP client and authentication for your server.

[users.ts](users.ts) is the supporting domain service. Its in-memory implementation owns tenant-scoped reads and writes; it knows nothing about HTTP or MCP.

## Registration

```ts
export const layer = Layer.mergeAll(
  ActionHttp.layer(App),
  ActionMcp.layer(App, { name: "effect-actions", version: "0.0.0" }),
).pipe(Layer.provide(Authentication.layer), Layer.provide(Users.layerMemory));
```

`ActionHttp.layer` registers one native `POST /api/actions/<name>` endpoint per HTTP-enabled action, plus `GET /openapi.json`. All endpoints belong to one `actions` group, with operation IDs such as `actions.getUser`. `ActionMcp.layer` mounts Effect's native `McpServer` at `/mcp` and registers one tool per MCP-enabled action.

The implementation is opaque; there is no public `App.handlers` or `App.layer`. Both adapters acquire the same private binding once per runtime, and release scoped resources when that runtime closes.

`Authentication` is `HttpRouter.middleware<{ provides: CurrentActor }>`. Because the handlers read `CurrentActor`, both adapters require it per request; the middleware satisfies that requirement for every route it wraps, including `/mcp`. Leave it out and `HttpRouter.serve` does not compile. A build-only actor cannot serve as a runtime fallback on either transport; a value explicitly supplied in the request context is still the host's responsibility.

## Follow a request

```text
POST /api/actions/getUser     MCP get_user({ id: "1" })
body: { "id": "1" }
      │                                 │
      └──────── host authentication ────┘   provides CurrentActor to the request fiber
                         │
        HttpApiBuilder / McpServer.addTool   decode input with the action's codec
                         │
              bound getUser handler
              authorize("users:read")        reads CurrentActor, fails with Forbidden
                         │
             Users.get(actor.tenantId, id)
                         │
       encode result, or fail with UserNotFound / Forbidden
                         │
     HttpApi encodes 404 / 403 · MCP encodes an isError result
```

`UserNotFound` declares `{ httpApiStatus: 404 }` and `Forbidden` `{ httpApiStatus: 403 }` on their schemas; each appears in the action's `error` list and in the OpenAPI document. Unannotated errors use the native 500 default.

Every action uses a generated `POST /api/actions/<name>` endpoint:

- `getUser` — a tenant-scoped read, also published under the MCP alias `get_user`.
- `renameUser` — a write whose result is visible through both transports.
- `double` — encoded input `{ "value": "21" }` becomes numeric input inside the handler, which returns `42`.
- `whoAmI` — trusted identity arrives from the request context, never from action arguments.

To add an action, define its contract, add it to `Actions`, and add its handler to `Actions.implement`; the missing handler is a compile error until you do. Default HTTP and MCP registration need no further wiring.

This is a demo: bearer tokens are hardcoded, data is not persistent, and the Effect RpcGroup protocol is not implemented.
