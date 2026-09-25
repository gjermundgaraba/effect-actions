# ActionHttp

JSON `POST` routes on Effect's `HttpApi`. One `ActionHttp.make` binds actions, a mount path
and the errors around them into a binding shared by the server, every client, and the OpenAPI
document. The binding is data, so a browser client importing it bundles no server code;
servers mount it with `ActionHttp.layer(Http, implementations)`.

## API

Import `@gjermundgaraba/effect-actions/ActionHttp`.

| API                           | Purpose                                                                          |
| ----------------------------- | -------------------------------------------------------------------------------- |
| `make(actions, options?)`     | Bind a list of actions; returns `Http`.                                          |
| `Http.actions`                | The exact bound actions.                                                         |
| `Http.errors`                 | The binding's errors, declared on every endpoint.                                |
| `Http.prefix`                 | The mount path: `/api` by default, empty at the root.                            |
| `Http.schemaError`            | The schema-error answers `make` was given, which `layer` applies.                |
| `Http.api`                    | Native Effect `HttpApi` for clients and OpenAPI.                                 |
| `layer(Http, apps, options?)` | Mount the routes of these implementations, with one hook; omit it for none.      |
| `openApi(Http, path?)`        | Serve the OpenAPI document with `GET path`; defaults to `<prefix>/openapi.json`. |

Exported types: `Options`, `LayerOptions`, `Http`.

| Option                | Meaning                                                                                                                                             |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `make`: `prefix`      | Mount path of every route; defaults to `/api`. `/` mounts at the root; a trailing slash is dropped.                                                 |
| `make`: `name`        | The native group's name and OpenAPI tag; defaults to the mount path's segments (`api`, `api/billing`), or `actions` at the root.                    |
| `make`: `errors`      | Error codecs declared on every endpoint, beyond each action's own; defaults to none.                                                                |
| `make`: `schemaError` | `{ invalid?, internal? }`, each answering a decoding or encoding failure with one of `errors`: see [Schema errors](#schema-errors).                 |
| `layer`: `before`     | Effectful hook receiving the selected `Action.Any`, after successful input decoding and before its handler. It fails with one of `make`'s `errors`. |

Routes: each action is served at `POST <prefix>/<action>`, operation ID `<action>`, OpenAPI tag
`name`, by default the mount path's segments (`api`).

Layer failures and startup requirements come from the builders of the supplied
implementations. Every handler's and the hook's request services remain router request
requirements; router/platform services are also required. No request identity is supplied at startup.

## Canonical

The binding, shared by the server and every client:

```ts
import * as ActionHttp from "@gjermundgaraba/effect-actions/ActionHttp";
import { Forbidden, Unauthenticated } from "./auth.js";
import {
  Double,
  GetUser,
  InternalError,
  InvalidRequest,
  RenameUser,
  Status,
  WhoAmI,
} from "./contracts.js";

// Contract-level: the server and its clients share it, and it is plain data, so a
// browser client importing it bundles no server code. The binding declares the failures
// the surface itself answers with, so a typed client decodes the 401 from
// authentication middleware, the 403 from the authorization hook, and the answers to
// malformed requests and unencodable results instead of reporting a decode error. No
// handler can return any of them. `ListChanges` is a tool for agents reviewing what
// happened, so HTTP leaves it out.
export const Http = ActionHttp.make([Status, GetUser, RenameUser, Double, WhoAmI], {
  errors: [Unauthenticated, Forbidden, InvalidRequest, InternalError],
  schemaError: {
    invalid: () =>
      new InvalidRequest({ message: "The request does not match the action's input." }),
    internal: () => new InternalError({ message: "The request could not be completed." }),
  },
});
```

### Serving

```ts
import { Layer } from "effect";
import { HttpApiSwagger } from "effect/unstable/httpapi";
import * as ActionHttp from "@gjermundgaraba/effect-actions/ActionHttp";
import { guarded } from "./auth.js";
import { authentication } from "./authentication.js";
import { Http } from "./binding.js";
import { double, status, userActions } from "./handlers.js";

// One layer per access rule: middleware provided to a layer applies to the routes of
// the actions it serves, and to no others. Status needs no credentials, so it binds no
// hook; every user action is authorized after decoding, before its handler runs.
const routes = Layer.mergeAll(
  ActionHttp.layer(Http, status),
  ActionHttp.layer(Http, [userActions, double], guarded).pipe(Layer.provide(authentication.layer)),
);

// `Http.api` is a native HttpApi, so documents are Effect's own: the OpenAPI JSON at
// `GET /api/openapi.json`, and a Swagger UI reading the same contract.
const documentation = Layer.mergeAll(
  ActionHttp.openApi(Http),
  HttpApiSwagger.layer(Http.api, { path: "/docs" }),
);

export const layer = Layer.mergeAll(routes, documentation);
```

Serve with `HttpRouter.serve(layer).pipe(Layer.provide(NodeHttpServer.layer(createServer, { port })), Layer.launch)`.

A large API, or two actions that would share a name, gets one binding per area, each with its
own `prefix` and client, composed into one host:

```ts
export const Billing = ActionHttp.make([Invoice, Refund], {
  prefix: "/api/billing",
  name: "Billing",
});
export const Accounts = ActionHttp.make([GetUser, RenameUser], {
  prefix: "/api/accounts",
  name: "Accounts",
});

const routes = Layer.mergeAll(
  ActionHttp.layer(Billing, billing),
  ActionHttp.layer(Accounts, accounts),
);

// One document for both: HttpApi.make("app").addHttpApi(Billing.api).addHttpApi(Accounts.api)
```

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
- `errors` declares the failures the surface around these endpoints answers with rather than a handler: authentication, authorization, rate limiting, invalid input, upstream unavailability. They are added to every endpoint's error schemas, so `ActionHttpClient`, a remote `ActionCli` command, `Testing.httpClient` and the native `HttpApiClient` decode them as typed failures, and they appear in OpenAPI on every operation. A schema an action already declares is not repeated.
- Schemas reachable from one endpoint must have distinct `_tag`s: the client decodes a response by trying the schemas declared for its status, and two errors may share a status. Effect unions them per status.
- `errors` changes only what is declared. Only the surface produces them: the middleware that renders those responses, the hook, and `schemaError`. Middleware must encode a body that matches the schema, or the client sees a decode error again. Handlers cannot fail with them.
- `layer(Http, apps, options?)` mounts the routes of every action of the implementations it receives. Each action must be the exact contract value passed to `make`: an equal-looking action is refused at runtime, and the types refuse only an action of another shape. An action may be served once per call. An action no layer serves still appears in `Http.api`, OpenAPI and clients, and answers 404.
- The binding is plain data: `layer` and `openApi` read everything from its fields, so a copy of the binding, or one made by another installed copy of the package, serves the same.
- The hook fails only with the binding's `errors`: failing with anything else is a type error. A guard shared with the tool surfaces, `{ errors, before }`, is passed as it is; HTTP reads only `before` (see [guarantees.md](guarantees.md#dependency-lifetimes)).
- Middleware and the hook are per layer call. Actions that need different middleware go in separate `layer` calls, merged with `Layer.mergeAll`; they still share one binding, one document and one client. A builder runs once for the host however many calls serve its implementation.
- `before` follows the hook rules in [guarantees.md](guarantees.md#dependency-lifetimes). On HTTP a refusal uses the binding's declared error schema and `httpApiStatus`, and admission that must precede decoding belongs in outer native HTTP middleware.
- `ActionHttp` sets no response headers of its own. The host owns cache policy; `Authentication.middleware` marks its responses `cache-control: no-store`.
- A hook refusal and a handler error are plain declared errors: a JSON body and a status, no other headers. Challenge headers such as `WWW-Authenticate` belong to the admission middleware that runs before the router reaches these routes (see [Authentication.md](Authentication.md)), which sets them on its own response.
- Request-time handler services are `HttpRouter.Request.From<"Requires", R>`. Supply them with router middleware (`Authentication.middleware`, `HttpRouter.middleware`), `HttpRouter.provideRequest`, or the request context. Build-time services are ordinary layer requirements.
- `Http.api` is a plain `HttpApi`. Anything Effect can do with an `HttpApi` works: `OpenApi.fromApi`, `HttpApiSwagger.layer`, `HttpApiScalar.layer`, `HttpApi.addHttpApi` to combine with other APIs, `HttpApiClient.make`. The endpoints are one top-level group, named `name`, so the native client exposes them as `client.<action>({ payload })`, and bindings on different prefixes compose into one host API with `HttpApi.addHttpApi`. Composed bindings need distinct names: with the same name, which the same prefix gives by default, one binding's group replaces the other's even when their actions differ. Serving several bindings with `layer` is unaffected.
- `openApi(Http, path?)` is `OpenApi.fromApi(Http.api)` as one `GET` route, `<prefix>/openapi.json` unless a path is given. It documents every bound action, not only the served ones. It is a plain route: middleware provided to its layer covers it, and nothing covers it otherwise.
- Wire format: success is the encoded body, a declared error is its JSON encoding with its `httpApiStatus`, a defect is an empty 500, and schema failures are answered as [Schema errors](#schema-errors) describes. Full table in [guarantees.md](guarantees.md).
- Each handler runs in a span named after its action, a child of the request span, attributed with `action.name` and `action.access`; its log lines carry the same annotations. The hook, decoding and encoding are outside it, in the request span.

### Schema errors

- Without `schemaError`, or for a side it leaves out, HTTP answers decoding and encoding failures with Effect's native empty 400.
- The library picks the side from the native `HttpApiSchemaError`'s `kind`. Request-side kinds (`Payload`, `Params`, `Headers`, `Query`: the request did not decode) go to `invalid`; response-side kinds (`Body`, `ResponseHeaders`: the handler's result did not encode) go to `internal`. The side receives the failure (`kind`, `cause`) and returns one of the binding's `errors`, sent with its `httpApiStatus`.
- The answers are ordinary binding errors: declare them in `errors`, and they appear in `Http.api`, clients, and OpenAPI like any other. An answer that is not one of `errors` is a type error.
- In practice only `Payload` and `Body` occur: actions declare no parameters, query, or headers, and no response headers.
- MCP is unaffected. The native `McpServer` answers invalid arguments and unencodable results itself.
- `schemaError` runs only on the server. Client-side codec failures stay `SchemaError`.
- HTTP decodes with `errors: "all"`, so `cause` carries every issue. Issues never retain the rejected values.
- One `schemaError` covers every endpoint of the binding, in every `layer` serving it. Actions that need other answers go in another binding with another `prefix`.
- Input failures are answered before the `before` hook. Invalid input is answered without invoking the hook or handler.
- Domain errors, defects, interruptions, and protocol errors are not remapped. An unencodable declared error is a defect. An answer that does not encode is not recursively remapped: the response is an empty 500.

## Failure modes

- Route returns 404: the implementation was never passed to a `layer` call, or the path lacks the prefix.
- Type error at `layer`, or `Action "x" is not in this HTTP binding` thrown by it: the implementation's action was not passed to this binding's `make`. Implement the exact contract value the binding received, or add the action to the binding. Matching names and schemas do not establish identity.
- `Duplicate served action: <name>`: one `layer` call received two implementations of the same action.
- `Method 'POST' already declared for route '<prefix>/<action>'` when the host builds: two `layer` calls serve the same action. Serve each action in one call.
- `Duplicate action: <name>` thrown by `make`: two actions share a name, or one action value is listed twice. Rename one, or bind it under another prefix.
- Type error listing `HttpRouter.Request.From<"Requires", CurrentActor>` as unsatisfied: a handler yields a request service and no middleware provides it. Wrap that `layer` call with the middleware's `.layer`.
- Client method missing for an action: the action is not in the binding's contracts.
- Empty 400 on a valid-looking request: input did not decode. Set `schemaError.invalid` on the binding to get a typed body, and check `Content-Type: application/json`.
- 415: wrong or missing content type.
- `HttpClientError: Decode error (401 POST ...)` from a typed client: the surface answered with a status no endpoint declares. Add that error schema to `ActionHttp.make`'s `errors`.
- A surface error decodes as the wrong type: two schemas that share a status also share a `_tag`. Give them distinct tags.
- The hook's services appear as unsatisfied `HttpRouter.Request.From<"Requires", ...>`: the hook yields an identity tag and this `layer` call has no middleware providing it. Wrap that call with the middleware's `.layer`.
- Type error at `layer` naming `before`: the hook refuses with an error the binding does not declare. Add its schema to `ActionHttp.make`'s `errors`.
- Type error at `make` naming `schemaError`: an answer is not one of `errors`. Declare its schema there.
- `Parameter 'failure' implicitly has an 'any' type` in a standalone `schemaError` constant: an answer that reads the failure is typed only inline. Annotate the parameter as `HttpApiError.HttpApiSchemaError` (type import from `effect/unstable/httpapi`).
