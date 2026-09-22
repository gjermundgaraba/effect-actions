# ActionHttp

JSON `POST` routes on Effect's `HttpApi`. One `ActionHttp.make` binds a mount path and a set
of groups into a contract value shared by the server, every client, and the OpenAPI document.

## API

Import `@gjermundgaraba/effect-actions/ActionHttp`.

| API                          | Purpose                                                                              |
| ---------------------------- | ------------------------------------------------------------------------------------ |
| `make(options, ...groups)`   | Bind contracts and a mount path; returns `Http`.                                     |
| `Http.groups`                | The exact bound contracts, in declaration order.                                     |
| `Http.api`                   | Native Effect `HttpApi` for clients and OpenAPI.                                     |
| `Http.layer(apps, options?)` | Serve a readonly collection of implementations; omit options when no hook is needed. |
| `Http.openApi(path?)`        | Serve the OpenAPI document with `GET path`; defaults to `<apiPath>/openapi.json`.    |

Exported types: `Options`, `LayerOptions`, `Http`, `Api`.

| Option            | Meaning                                                                                                                                                     |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `make`: `apiPath` | Required absolute mount path; no default.                                                                                                                   |
| `make`: `errors`  | Surface error codecs declared on every endpoint; defaults to none.                                                                                          |
| `layer`: `before` | Effectful hook receiving the selected `Action.Any`, after successful input decoding and before its handler. Failures must belong to the binding's `errors`. |

Layer failures and startup requirements come from the supplied implementations that actually
serve HTTP actions. Served handlers' and the hook's request services remain router request
requirements; router/platform services are also required. No request identity is supplied at startup.

Route shape: `POST <apiPath>/<group>/<action>`. Operation ID: `<group>.<action>`.

## Canonical

```ts
import { Layer } from "effect";
import { HttpApiScalar, HttpApiSwagger } from "effect/unstable/httpapi";
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
  Http.layer([PublicApp]),
  Http.layer([UserApp], { before: authorize }).pipe(Layer.provide(authentication.layer)),
);

// Documents are Effect's own, reading the same contract: `GET /api/actions/openapi.json`.
const documentation = Layer.mergeAll(
  Http.openApi(),
  HttpApiSwagger.layer(Http.api, { path: "/docs" }),
  HttpApiScalar.layer(Http.api, { path: "/reference" }),
);

export const layer = Layer.mergeAll(routes, documentation);
```

Serve with `HttpRouter.serve(layer).pipe(Layer.provide(NodeHttpServer.layer(createServer, { port })), Layer.launch)`.

### Client

The client is Effect's native grouped `HttpApiClient` over `Http.api`. Code that does not
run Effects uses the Promise client in [ActionHttpClient.md](ActionHttpClient.md).

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
- `Http.layer(apps, options?)` requires each implementation to reference the exact group object passed to `make`; reconstructing an equal-looking group is not sufficient. Each group may occur only once per call. Only supplied implementations are mounted, and a group with no HTTP-enabled actions is not built. Options are optional.
- `before` runs after successful native input decoding and before the selected handler. Invalid input skips the hook and handler. A refusal uses the binding's declared error schema and `httpApiStatus`; its services join handler request requirements. Admission that must precede decoding belongs in outer native HTTP middleware.
- Middleware and the hook are per layer call. Groups that need different middleware or a different policy go in separate `Http.layer` calls, merged with `Layer.mergeAll`.
- `ActionHttp` sets no response headers of its own. The host owns cache policy; `Authentication.middleware` marks its responses `cache-control: no-store`.
- A hook refusal and a handler error are plain declared errors: a JSON body and a status, no other headers. Challenge headers such as `WWW-Authenticate` belong to the admission middleware that runs before the router reaches these routes (see [Authentication.md](Authentication.md)), which sets them on its own response.
- Request-time handler services are `HttpRouter.Request.From<"Requires", R>`. Supply them with router middleware (`Authentication.middleware`, `HttpRouter.middleware`), `HttpRouter.provideRequest`, or the request context. Build-time services are ordinary layer requirements.
- `Http.api` is a plain `HttpApi`. Anything Effect can do with an `HttpApi` works: `OpenApi.fromApi`, `HttpApiSwagger.layer`, `HttpApiScalar.layer`, `HttpApi.addHttpApi` to combine with other APIs, `HttpApiClient.make`.
- `Http.openApi(path?)` is `OpenApi.fromApi(Http.api)` as one `GET` route, `<apiPath>/openapi.json` unless a path is given. It documents every bound group, not only the served ones. It is a plain route: middleware provided to its layer covers it, and nothing covers it otherwise.
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
