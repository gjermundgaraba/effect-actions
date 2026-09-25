# ActionHttp

JSON `POST` routes on Effect's `HttpApi`. One `ActionHttp.make` binds actions, a mount path
and the errors around them into a binding shared by the server, every client, and the OpenAPI
document. Servers mount it with `Http.layer(implementations)`.

## API

Import `@gjermundgaraba/effect-actions/ActionHttp`.

| API                          | Purpose                                                                           |
| ---------------------------- | --------------------------------------------------------------------------------- |
| `make(actions, options?)`    | Bind a list of actions; returns `Http`.                                           |
| `Http.actions`               | The exact bound actions.                                                          |
| `Http.errors`                | The surface and policy errors declared on every endpoint.                         |
| `Http.api`                   | Native Effect `HttpApi` for clients and OpenAPI.                                  |
| `Http.layer(apps, options?)` | Mount the routes of these implementations, under one hook; omit options for none. |
| `Http.openApi(path?)`        | Serve the OpenAPI document with `GET path`; defaults to `<prefix>/openapi.json`.  |

Exported types: `Options`, `LayerOptions`, `Http`, `HttpLayer`, `Api`,
`SchemaErrorPolicy`, `SchemaErrorAnswer`.

| Option                | Meaning                                                                                                                                                     |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `make`: `prefix`      | Mount path of every route; defaults to `/api`. `/` mounts at the root; a trailing slash is dropped.                                                         |
| `make`: `errors`      | Surface error codecs declared on every endpoint; defaults to none.                                                                                          |
| `make`: `schemaError` | Schema-error policy for every endpoint; without one, decoding and encoding failures are Effect's empty 400.                                                 |
| `layer`: `before`     | Effectful hook receiving the selected `Action.Any`, after successful input decoding and before its handler. Failures must belong to the binding's `errors`. |

Routes: each action is served at `POST <prefix>/<action>`, operation ID `<action>`, OpenAPI tag
the mount path (`/api`).

Layer failures and startup requirements come from the builders of the supplied
implementations. Every handler's and the hook's request services remain router request
requirements; router/platform services are also required. No request identity is supplied at startup.

## Canonical

```ts
import { Layer, Schema } from "effect";
import { HttpApiScalar, HttpApiSwagger } from "effect/unstable/httpapi";
import * as ActionHttp from "@gjermundgaraba/effect-actions/ActionHttp";
import { Double, GetUser, RenameUser, Status, WhoAmI } from "./contracts.js";
import { double, status, userActions } from "./handlers.js";
import { authentication, authorize, Forbidden, Unauthenticated } from "./auth.js";

class InvalidRequest extends Schema.TaggedError<InvalidRequest>()(
  "InvalidRequest",
  { message: Schema.String },
  { httpApiStatus: 400 },
) {}
class InternalError extends Schema.TaggedError<InternalError>()(
  "InternalError",
  { message: Schema.String },
  { httpApiStatus: 500 },
) {}

// Contract: shared by server and clients. `errors` are the failures the surface
// itself renders — here the 401 from `authentication` and the 403 from the hook
// below — so a typed client decodes them instead of reporting a decode error on
// an unexpected status. A request that does not decode is the caller's fault; a
// result that does not encode is the server's.
export const Http = ActionHttp.make([Status, GetUser, RenameUser, Double, WhoAmI], {
  errors: [Unauthenticated, Forbidden],
  schemaError: {
    invalid: {
      schema: InvalidRequest,
      make: () => new InvalidRequest({ message: "The request does not match the action's input." }),
    },
    internal: {
      schema: InternalError,
      make: () => new InternalError({ message: "The request could not be completed." }),
    },
  },
});

// One layer per middleware set. Middleware provided to a layer applies to the routes
// of the actions it serves, and so does its `before` hook.
const routes = Layer.mergeAll(
  Http.layer(status),
  Http.layer([...userActions, ...double], { before: authorize }).pipe(
    Layer.provide(authentication.layer),
  ),
);

// Documents are Effect's own, reading the same contract: `GET /api/openapi.json`.
const documentation = Layer.mergeAll(
  Http.openApi(),
  HttpApiSwagger.layer(Http.api, { path: "/docs" }),
  HttpApiScalar.layer(Http.api, { path: "/reference" }),
);

export const layer = Layer.mergeAll(routes, documentation);
```

Serve with `HttpRouter.serve(layer).pipe(Layer.provide(NodeHttpServer.layer(createServer, { port })), Layer.launch)`.

A large API, or two actions that would share a name, gets one binding per area, each with its
own `prefix` and client: `ActionHttp.make(billing, { prefix: "/api/billing" })`.

### Client

`ActionHttpClient.make(Http)` is Effect's native `HttpApiClient` with one method per action
taking its input directly (see [ActionHttpClient.md](ActionHttpClient.md)).

```ts
import { Effect } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import * as ActionHttpClient from "@gjermundgaraba/effect-actions/ActionHttpClient";
import { Http } from "./quickstart.js";

export const greeting = Effect.gen(function* () {
  const client = yield* ActionHttpClient.make(Http, { baseUrl: "http://127.0.0.1:3000" });

  return yield* client.greet({ name: "Ada" });
}).pipe(Effect.provide(FetchHttpClient.layer));
```

## Rules

- HTTP serves exactly the actions passed to `make`; an action has no HTTP switch. To keep an action off HTTP, leave it out of the list and serve it elsewhere (MCP, Toolkit, CLI).
- Action names are unique within a binding. Two bindings with different prefixes may reuse a name.
- `errors` declares the failures the surface around these endpoints answers with rather than a handler: authentication, authorization, rate limiting, upstream unavailability. They are added to every endpoint's error schemas, so `ActionHttpClient`, `ActionCliClient`, `Testing.httpClient` and the native `HttpApiClient` decode them as typed failures, and they appear in OpenAPI on every operation. A schema an action already declares is not repeated.
- Schemas reachable from one endpoint must have distinct `_tag`s: the client decodes a response by trying the schemas declared for its status, and two errors may share a status. Effect unions them per status.
- `errors` changes only what is declared. Nothing produces them: the middleware that renders those responses must encode a body that matches the schema, or the client sees a decode error again. Handlers cannot fail with them.
- `Http.layer(apps, options?)` mounts the routes of exactly the implementations it receives. Each implementation's action must be the exact contract value passed to `make`; an equal-looking action is refused. An action may be served once per call. An action no layer serves still appears in `Http.api`, OpenAPI and clients, and answers 404.
- Middleware and the hook are per layer call. Actions that need different middleware go in separate `Http.layer` calls, merged with `Layer.mergeAll`; they still share one binding, one document and one client. Each call runs the builders of its own implementations, so put a resource both calls use, such as a connection pool, in a Layer provided to both, not in a builder.
- `before` follows the hook rules in [guarantees.md](guarantees.md#dependency-lifetimes). On HTTP a refusal uses the binding's declared error schema and `httpApiStatus`, and admission that must precede decoding belongs in outer native HTTP middleware.
- `ActionHttp` sets no response headers of its own. The host owns cache policy; `Authentication.middleware` marks its responses `cache-control: no-store`.
- A hook refusal and a handler error are plain declared errors: a JSON body and a status, no other headers. Challenge headers such as `WWW-Authenticate` belong to the admission middleware that runs before the router reaches these routes (see [Authentication.md](Authentication.md)), which sets them on its own response.
- Request-time handler services are `HttpRouter.Request.From<"Requires", R>`. Supply them with router middleware (`Authentication.middleware`, `HttpRouter.middleware`), `HttpRouter.provideRequest`, or the request context. Build-time services are ordinary layer requirements.
- `Http.api` is a plain `HttpApi`. Anything Effect can do with an `HttpApi` works: `OpenApi.fromApi`, `HttpApiSwagger.layer`, `HttpApiScalar.layer`, `HttpApi.addHttpApi` to combine with other APIs, `HttpApiClient.make`. The endpoints are one top-level group named after the mount path, so the native client exposes them as `client.<action>({ payload })`, and bindings on different prefixes compose into one host API with `HttpApi.addHttpApi`. Composed bindings need distinct prefixes: on the same prefix, one binding's group replaces the other's even when their actions differ. Serving several bindings with `Http.layer` is unaffected.
- `Http.openApi(path?)` is `OpenApi.fromApi(Http.api)` as one `GET` route, `<prefix>/openapi.json` unless a path is given. It documents every bound action, not only the served ones. It is a plain route: middleware provided to its layer covers it, and nothing covers it otherwise.
- Wire format without a policy: input failure is an empty 400, success is the encoded body, a declared error is its JSON encoding with its `httpApiStatus`, an encoding failure is an empty 400, a defect is an empty 500. Full table in [guarantees.md](guarantees.md).
- Each handler runs in a span named after its action, a child of the request span, attributed with `action.name` and `action.access`; its log lines carry the same annotations. The hook, decoding and encoding are outside it, in the request span.

### Schema-error policy

- Without a policy, HTTP answers decoding and encoding failures with Effect's native empty 400.
- With a policy, the library picks the answer from the native `HttpApiSchemaError`'s `kind`. Request-side kinds (`Payload`, `Params`, `Headers`, `Query`: the request did not decode) get `invalid`; response-side kinds (`Body`, `ResponseHeaders`: the handler's result did not encode) get `internal`. `make` receives the failure (`kind`, `cause`) and returns its schema's value. HTTP uses that error's `httpApiStatus`, and both errors appear in `Http.errors`, `Http.api`, clients, and OpenAPI.
- In practice only `Payload` and `Body` occur: actions declare no parameters, query, or headers, and no response headers.
- `invalid` and `internal` may share one schema; it is declared once.
- MCP is unaffected. The native `McpServer` answers invalid arguments and unencodable results itself.
- Policy errors extend the transport contract, not the handler contract. A handler cannot return them.
- The policy runs only on the server. Client-side codec failures stay `SchemaError`.
- HTTP decodes with `errors: "all"`, so `cause` carries every issue. Issues never retain the rejected values.
- One policy covers every endpoint of the binding. Actions that need another policy go in another binding with another `prefix`.
- Input schema-error policies run before the `before` hook. Invalid input is answered by the policy without invoking the hook or handler.
- Domain errors, defects, interruptions, and protocol errors are not remapped. An unencodable declared error is a defect. A broken policy error is not recursively remapped.

## Failure modes

- Route returns 404: the implementation was never passed to an `Http.layer` call, or the path lacks the prefix.
- `Action "x" is not in this HTTP binding` thrown by `Http.layer`: the implementation's action was not passed to this binding's `make`. Implement the exact contract value the binding received, or add the action to the binding. Matching names and schemas do not establish identity.
- `Duplicate served action: <name>`: one `Http.layer` call received two implementations of the same action.
- `Duplicate action: <name>` thrown by `make`: two actions share a name, or one action value is listed twice. Rename one, or bind it under another prefix.
- Type error listing `HttpRouter.Request.From<"Requires", CurrentActor>` as unsatisfied: a handler yields a request service and no middleware provides it. Wrap that `Http.layer` call with the middleware's `.layer`.
- Client method missing for an action: the action is not in the binding's contracts.
- Empty 400 on a valid-looking request: input did not decode. Set a `schemaError` policy on the binding to get a typed body, and check `Content-Type: application/json`.
- 415: wrong or missing content type.
- `HttpClientError: Decode error (401 POST ...)` from a typed client: the surface answered with a status no endpoint declares. Add that error schema to `ActionHttp.make`'s `errors`.
- A surface error decodes as the wrong type: two schemas that share a status also share a `_tag`. Give them distinct tags.
- The hook's services appear as unsatisfied `HttpRouter.Request.From<"Requires", ...>`: the hook yields an identity tag and this `Http.layer` call has no middleware providing it. Wrap that call with the middleware's `.layer`.
- A refusal returns 500 instead of its status: the hook failed with an error the binding does not declare. Add its schema to `ActionHttp.make`'s `errors`.
- `Parameter 'failure' implicitly has an 'any' type` in a standalone policy constant: a `make` that reads the failure is typed only inline. Annotate the parameter as `HttpApiError.HttpApiSchemaError` (type import from `effect/unstable/httpapi`), or annotate the constant as `ActionHttp.SchemaErrorPolicy<typeof Invalid, typeof Internal>`.
