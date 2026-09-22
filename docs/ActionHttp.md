# ActionHttp

JSON `POST` routes on Effect's `HttpApi`. One `ActionHttp.make` binds a mount path and a set
of groups into a contract value shared by the server, every client, and the OpenAPI document.

## API

```ts
import * as ActionHttp from "@gjermundgaraba/effect-actions/ActionHttp";

function make<const G extends ReadonlyArray<Actions>, const E extends ReadonlyArray<Codec> = []>(
  options: Options<E>,
  ...groups: G
): Http<G, E>;

interface Options<Errors = []> {
  readonly apiPath: `/${string}`; // no default
  readonly errors?: Errors; // failures the surface answers with, declared on every endpoint
}

interface LayerOptions<Errors, RB> {
  /** Runs before the payload is decoded, on every request this layer answers. */
  readonly before?: (action: Action.Any) => Effect.Effect<void, Errors[number]["Type"], RB>;
}

interface Http<Groups, Errors = []> {
  readonly groups: Groups; // the exact contracts bound, in declaration order
  readonly api: HttpApi.HttpApi<"actions", ...>; // native HttpApi, one HttpApiGroup per group
  /** Serve implementations. Errors and requirements are unions over exactly these apps. */
  readonly layer: <const Apps extends ReadonlyArray<AnyImplementation<Groups[number]>>, RB = never>(
    options: LayerOptions<Errors, RB>,
    ...apps: Apps
  ) => Layer.Layer<
    never,
    BuildError<Apps[number]>,
    | BuildContext<Apps[number]>
    | HttpRouter.HttpRouter
    | HttpRouter.Request.From<"Requires", RequestContext<Apps[number]> | RB>
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
import { authentication, authorize, Forbidden, Unauthenticated } from "./auth.js";

// Contract: shared by server and clients. `errors` are the failures the surface
// itself renders — here the 401 from `authentication` and the 403 from the hook
// below — so a typed client decodes them instead of reporting a decode error on
// an unexpected status.
export const Http = ActionHttp.make(
  { apiPath: "/api/actions", errors: [Unauthenticated, Forbidden] },
  PublicActions,
  UserActions,
);

// One layer per middleware set and per policy. Middleware provided to a layer
// applies to that layer only, and so does its `before` hook.
const routes = Layer.mergeAll(
  Http.layer({}, PublicApp),
  Http.layer({ before: authorize }, UserApp).pipe(Layer.provide(authentication.layer)),
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
- `errors` declares the failures the surface around these endpoints answers with rather than a handler: authentication, authorization, rate limiting, upstream unavailability. They are added to every endpoint's error schemas, so `HttpApiClient`, `ActionCliClient` and the in-memory `Testing.httpClient` decode them as typed failures, and they appear in OpenAPI on every operation. A schema an action already declares is not repeated.
- Schemas reachable from one endpoint must have distinct `_tag`s: the client decodes a response by trying the schemas declared for its status, and two errors may share a status. Effect unions them per status.
- `errors` changes only what is declared. Nothing produces them: the middleware that renders those responses must encode a body that matches the schema, or the client sees a decode error again. Handlers cannot fail with them.
- `Http.layer(options, ...apps)` requires each implementation to reference the exact group object passed to `make`; reconstructing an equal-looking group is not sufficient. Import the shared group value and call its `implement`. Each group may occur only once in a single `layer` call. It mounts only the supplied implementations. A group that is never passed to `layer` has no routes. A group with no HTTP-enabled actions is not built at all. The options object is required; pass `{}` for a surface with no hook.
- `before` runs once per request, with the selected action contract, **before the payload is decoded**, so an unauthorized caller learns nothing about the input schema and the handler never runs. It fails with the binding's own `errors`, and that failure is encoded exactly like a declared error, with the schema's `httpApiStatus`. Its services are request-time requirements, joined with the handlers'.
- Middleware and the hook are per layer call. Groups that need different middleware or a different policy go in separate `Http.layer` calls, merged with `Layer.mergeAll`.
- Every response these routes answer with a status of 400 or more carries `cache-control: no-store`, including hook refusals, declared errors and defects. Successful responses are left alone; only the host knows whether they are public. The middleware covers the action routes only, not the router's 404 for an unmatched path or anything else the host mounts.
- A hook refusal and a handler error are plain declared errors: a JSON body and a status, no other headers. Challenge headers such as `WWW-Authenticate` belong to the admission middleware that runs before the router reaches these routes (see [Authentication.md](Authentication.md)), which sets them on its own response.
- Request-time handler services are `HttpRouter.Request.From<"Requires", R>`. Supply them with router middleware (`Authentication.middleware`, `HttpRouter.middleware`), `HttpRouter.provideRequest`, or the request context. Build-time services are ordinary layer requirements.
- `Http.api` is a plain `HttpApi`. Anything Effect can do with an `HttpApi` works: `OpenApi.fromApi`, `HttpApiSwagger.layer`, `HttpApiScalar.layer`, `HttpApi.addHttpApi` to combine with other APIs, `HttpApiClient.make`.
- Client calls always take `{ payload }`. No-input actions take `{ payload: {} }`. Pass `null` or `undefined` only when the codec accepts it. There is no flat client.
- Client effects fail with the declared errors, the group's policy errors, the binding's `errors`, `SchemaError` for local codec failures, and native `HttpClientError`. MCP-only actions are absent from the client.
- Add authentication headers with the native `transformClient` option. Use `HttpApiClient.makeWith` for custom error or service channels. Native per-call response modes are available.
- Wire format without a policy: input failure is an empty 400, success is the encoded body, a declared error is its JSON encoding with its `httpApiStatus`, an encoding failure is an empty 400, a defect is an empty 500. Full table in [guarantees.md](guarantees.md).
- Each handler runs in a span named `<group>.<action>`, a child of the request span, attributed with `action.group`, `action.name` and `action.access`; its log lines carry the same annotations. The hook, decoding and encoding are outside it, in the request span.

## Failure modes

- Route returns 404: the implementation was never passed to `Http.layer`, or the action has `http: false`, or the path lacks the group segment.
- Type error listing `HttpRouter.Request.From<"Requires", CurrentActor>` as unsatisfied: a handler yields a request service and no middleware provides it. Wrap that `Http.layer` call with the middleware's `.layer`.
- Two groups share a name: `make` throws. Rename one.
- `Implementation of group "x" is not served by this adapter`: `Http.layer` received an implementation whose group was not passed to `ActionHttp.make`. Implement the exact shared group object bound by `make`, or add a genuinely new group to the binding. Matching names and schemas do not establish identity.
- `Duplicate implementation group: <name>`: a single `Http.layer` call received more than one implementation of the same group. Pass one implementation per group.
- Client method missing for an action: the action is `http: false`.
- Empty 400 on a valid-looking request: input did not decode. Set a `schemaError` policy on the group to get a typed body, and check `Content-Type: application/json`.
- 415: wrong or missing content type.
- `HttpClientError: Decode error (401 POST ...)` from a typed client: the surface answered with a status no endpoint declares. Add that error schema to `ActionHttp.make`'s `errors`.
- A surface error decodes as the wrong type: two schemas that share a status also share a `_tag`. Give them distinct tags.
- The hook's services appear as unsatisfied `HttpRouter.Request.From<"Requires", ...>`: the hook yields an identity tag and this `Http.layer` call has no middleware providing it. Wrap that call with the middleware's `.layer`.
- A refusal returns 500 instead of its status: the hook failed with an error the binding does not declare. Add its schema to `ActionHttp.make`'s `errors`.
