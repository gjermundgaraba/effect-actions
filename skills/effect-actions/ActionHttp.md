# ActionHttp

JSON `POST` routes on Effect's `HttpApi`. One `ActionHttp.make` binds a mount path and a set
of groups into a contract value shared by the server, every client, and the OpenAPI document.

## API

```ts
import * as ActionHttp from "@gjermundgaraba/effect-actions/ActionHttp";

function make<const G extends ReadonlyArray<Actions>>(options: Options, ...groups: G): Http<G>;

interface Options {
  readonly apiPath: `/${string}`; // no default
}

interface Http<Groups> {
  readonly groups: Groups; // the exact contracts bound, in declaration order
  readonly api: HttpApi.HttpApi<"actions", ...>; // native HttpApi, one HttpApiGroup per group
  /** Serve implementations. Errors and requirements are unions over exactly these apps. */
  readonly layer: <const Apps extends ReadonlyArray<AnyImplementation<Groups[number]>>>(
    ...apps: Apps
  ) => Layer.Layer<
    never,
    BuildError<Apps[number]>,
    | BuildContext<Apps[number]>
    | HttpRouter.HttpRouter
    | HttpRouter.Request.From<"Requires", RequestContext<Apps[number]>>
    | Etag.Generator | FileSystem | HttpPlatform.HttpPlatform | Path
  >;
}
```

Route shape: `POST <apiPath>/<group>/<action>`. Operation ID: `<group>.<action>`.

## Canonical

```ts
import { Layer } from "effect";
import { HttpRouter, HttpServerResponse } from "effect/unstable/http";
import { HttpApiScalar, HttpApiSwagger, OpenApi } from "effect/unstable/httpapi";
import * as ActionHttp from "@gjermundgaraba/effect-actions/ActionHttp";
import { PublicActions, UserActions } from "./contracts.js";
import { PublicApp, UserApp } from "./handlers.js";
import { authentication } from "./auth.js";

// Contract: shared by server and clients.
export const Http = ActionHttp.make({ apiPath: "/api/actions" }, PublicActions, UserActions);

// One layer per middleware set. Middleware provided to a layer applies to that layer only.
const routes = Layer.mergeAll(
  Http.layer(PublicApp),
  Http.layer(UserApp).pipe(Layer.provide(authentication.layer)),
);

// Documents are Effect's own, reading the same contract.
const documentation = Layer.mergeAll(
  HttpRouter.add("GET", "/openapi.json", HttpServerResponse.jsonUnsafe(OpenApi.fromApi(Http.api))),
  HttpApiSwagger.layer(Http.api, { path: "/docs" }),
  HttpApiScalar.layer(Http.api, { path: "/reference" }),
);

export const layer = Layer.mergeAll(routes, documentation);
```

Serve with `HttpRouter.serve(layer).pipe(Layer.provide(NodeHttpServer.layer(createServer, { port })), Layer.launch)`.

### Client

The client is Effect's native grouped `HttpApiClient` over `Http.api`:

```ts
import { HttpApiClient } from "effect/unstable/httpapi";
import { Effect } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { Http } from "./quickstart.js";

export const greeting = Effect.gen(function* () {
  const client = yield* HttpApiClient.make(Http.api, { baseUrl: "http://127.0.0.1:3000" });

  return yield* client.greetings.greet({ payload: { name: "Ada" } });
}).pipe(Effect.provide(FetchHttpClient.layer));
```

## Rules

- `apiPath` has no default. Group names must be unique within one `make`. Action names need only be unique within their group; equal action names in different groups do not collide.
- `Http.layer(...apps)` mounts only the supplied implementations. A group that is never passed to `layer` has no routes. A group with no HTTP-enabled actions is not built at all.
- Middleware is per layer call. Groups that need different middleware go in separate `Http.layer` calls, merged with `Layer.mergeAll`.
- Request-time handler services are `HttpRouter.Request.From<"Requires", R>`. Supply them with router middleware (`Authentication.middleware`, `HttpRouter.middleware`), `HttpRouter.provideRequest`, or the request context. Build-time services are ordinary layer requirements.
- `Http.api` is a plain `HttpApi`. Anything Effect can do with an `HttpApi` works: `OpenApi.fromApi`, `HttpApiSwagger.layer`, `HttpApiScalar.layer`, `HttpApi.addHttpApi` to combine with other APIs, `HttpApiClient.make`.
- Client calls always take `{ payload }`. No-input actions take `{ payload: {} }`. Pass `null` or `undefined` only when the codec accepts it. There is no flat client.
- Client effects fail with the declared errors, the group's policy errors, `SchemaError` for local codec failures, and native `HttpClientError`. MCP-only actions are absent from the client.
- Add authentication headers with the native `transformClient` option. Use `HttpApiClient.makeWith` for custom error or service channels. Native per-call response modes are available.
- Wire format without a policy: input failure is an empty 400, success is the encoded body, a declared error is its JSON encoding with its `httpApiStatus`, an encoding failure is an empty 400, a defect is an empty 500. Full table in [guarantees.md](guarantees.md).
- Each handler runs in a span named `<group>.<action>`, a child of the request span. Decoding and encoding are outside it.

## Failure modes

- Route returns 404: the implementation was never passed to `Http.layer`, or the action has `http: false`, or the path lacks the group segment.
- Type error listing `HttpRouter.Request.From<"Requires", CurrentActor>` as unsatisfied: a handler yields a request service and no middleware provides it. Wrap that `Http.layer` call with the middleware's `.layer`.
- Two groups share a name: `make` throws. Rename one.
- `Implementation of group "x" is not served by this adapter`: `Http.layer` received an implementation whose group was not passed to `ActionHttp.make`. Add the group to `make` or drop the app.
- Client method missing for an action: the action is `http: false`.
- Empty 400 on a valid-looking request: input did not decode. Set a `schemaError` policy on the group to get a typed body, and check `Content-Type: application/json`.
- 415: wrong or missing content type.
