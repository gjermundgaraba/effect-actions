# ActionHttp

JSON `POST` routes on Effect's `HttpApi`. `ActionHttp.make` binds actions to a mount path; the
binding is shared by the server, every client, and the OpenAPI document. It is data, so a
browser client importing it bundles no server code; servers mount it with
`ActionHttp.layer(Http, implementations)`.

## API

Import `@gjermundgaraba/effect-actions/ActionHttp`.

| API                           | Purpose                                                                          |
| ----------------------------- | -------------------------------------------------------------------------------- |
| `make(actions, options?)`     | Bind a list of actions; returns `Http`.                                          |
| `Http.actions`                | The exact bound actions.                                                         |
| `Http.prefix`                 | The mount path: `/api` by default, empty at the root.                            |
| `Http.api`                    | Native Effect `HttpApi` for clients and OpenAPI.                                 |
| `layer(Http, apps, options?)` | Mount the routes of these implementations, with an optional `before` hook.       |
| `openApi(Http, path?)`        | Serve the OpenAPI document with `GET path`; defaults to `<prefix>/openapi.json`. |

Exported type: `Http`.

| Option            | Meaning                                                                                                                 |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `make`: `prefix`  | Mount path of every route; defaults to `/api`. `/` mounts at the root; a trailing slash is dropped.                     |
| `layer`: `before` | Hook receiving the selected `Action.Any`, after successful input decoding and before its handler. Fails with a refusal. |

Routes: each action is served at `POST <prefix>/<action>`, operation ID `<action>`. The
OpenAPI tag is the mount path's segments (`api`, `v2/api`), or `actions` at the root. Every
endpoint declares its action's errors plus the built-in `InvalidInput` (400),
`Unauthenticated` (401) and `Forbidden` (403).

Layer failures and startup requirements come from the builders of the supplied
implementations. Every handler's and the hook's request services remain router request
requirements; router/platform services are also required. No request identity is supplied at startup.

## Canonical

The binding, shared by the server and every client:

```ts
import * as ActionHttp from "@gjermundgaraba/effect-actions/ActionHttp";
import { Double, GetUser, RenameUser, Status, WhoAmI } from "./contracts.js";

// Contract-level: the server and its clients share it, and it is plain data, so a
// browser client importing it bundles no server code. Every endpoint also declares the
// built-in `InvalidInput`, `Unauthenticated` and `Forbidden`, so a typed client decodes
// a malformed request, the authentication middleware's 401 and the authorization hook's
// 403 instead of reporting a decode error. `ListChanges` is a tool for agents reviewing
// what happened, so HTTP leaves it out.
export const Http = ActionHttp.make([Status, GetUser, RenameUser, Double, WhoAmI]);
```

### Serving

```ts
import { Layer } from "effect";
import { HttpApiSwagger } from "effect/unstable/httpapi";
import * as ActionHttp from "@gjermundgaraba/effect-actions/ActionHttp";
import { authentication } from "./authentication.js";
import { authorize } from "./authorization.js";
import { Http } from "./binding.js";
import { double, status, userActions } from "./handlers.js";

// One layer per access rule: middleware provided to a layer applies to the routes of
// the actions it serves, and to no others. Status needs no credentials, so it binds no
// hook; every user action is authorized after decoding, before its handler runs.
const routes = Layer.mergeAll(
  ActionHttp.layer(Http, status),
  ActionHttp.layer(Http, [userActions, double], { before: authorize }).pipe(
    Layer.provide(authentication.layer),
  ),
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
export const Billing = ActionHttp.make([Invoice, Refund], { prefix: "/api/billing" });
export const Accounts = ActionHttp.make([GetUser, RenameUser], { prefix: "/api/accounts" });

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
- `layer(Http, apps, options?)` mounts the routes of every action of the implementations it receives. Each action must be the exact contract value passed to `make`: an equal-looking action is refused at runtime, and the types refuse only an action of another shape. An action may be served once per call. An action no layer serves still appears in `Http.api`, OpenAPI and clients, and answers 404.
- The binding is plain data: `layer` and `openApi` read everything from its fields, so a copy of the binding, or one made by another installed copy of the package, serves the same.
- Middleware and the hook are per layer call. Actions that need different middleware go in separate `layer` calls, merged with `Layer.mergeAll`; they still share one binding, one document and one client. A builder runs once for the host however many calls serve its implementation.
- `before` follows the hook rules in [guarantees.md](guarantees.md#dependency-lifetimes). It fails only with `Action.Refusal`; anything else is a type error. Admission that must precede decoding belongs in outer native HTTP middleware.
- `ActionHttp` sets no response headers of its own. The host owns cache policy; `Authentication.middleware` marks its responses `cache-control: no-store`.
- Request-time handler services are `HttpRouter.Request.From<"Requires", R>`. Supply them with router middleware (`Authentication.middleware`, `HttpRouter.middleware`), `HttpRouter.provideRequest`, or the request context. Build-time services are ordinary layer requirements.
- `Http.api` is a plain `HttpApi`. Anything Effect can do with an `HttpApi` works: `OpenApi.fromApi`, `HttpApiSwagger.layer`, `HttpApiScalar.layer`, `HttpApi.addHttpApi` to combine with other APIs, `HttpApiClient.make`. The endpoints are one top-level group named after the mount path, so the native client exposes them as `client.<action>({ payload })`, and bindings on different prefixes compose into one host API with `HttpApi.addHttpApi`. Two bindings on the same prefix have the same group name: composed, one binding's group replaces the other's even when their actions differ. Serving several bindings with `layer` is unaffected.
- `openApi(Http, path?)` is `OpenApi.fromApi(Http.api)` as one `GET` route, `<prefix>/openapi.json` unless a path is given. It documents every bound action, not only the served ones. It is a plain route: middleware provided to its layer covers it, and nothing covers it otherwise.
- Wire format: success is the encoded body, a declared error is its JSON encoding with its `httpApiStatus`, a defect is an empty 500. Full table in [guarantees.md](guarantees.md#wire-behavior).
- Each handler runs in a span named after its action, a child of the request span, attributed with `action.name` and `action.access`; its log lines carry the same annotations. The hook, decoding and encoding are outside it, in the request span.

### Built-in errors

- Every endpoint declares `InvalidInput`, `Unauthenticated` and `Forbidden` beyond the action's own errors, so `ActionHttpClient`, a remote `ActionCli` command and the native `HttpApiClient` decode them as typed failures, and OpenAPI shows them on every operation. There is no option to declare more or fewer.
- Input that does not decode, malformed JSON included, is answered **400** `InvalidInput` whose `message` is the schema's own description of every issue: `{"_tag":"InvalidInput","message":"Expected string\n  at [\"name\"]"}`. The hook and handler never run. A wrong content type is Effect's own 415.
- A result that does not encode is a server bug: a defect, answered with an empty **500**. A typed client fails with `HttpClientError` (`DecodeError`, status 500).
- A `before` refusal is its JSON with 401 or 403. Every 401 a served route answers, a hook's or a handler's own, carries `WWW-Authenticate: Bearer`, as `Authentication.middleware`'s does ([Authentication.md](Authentication.md)).
- Schemas reachable from one endpoint must have distinct `_tag`s: the client decodes a response by trying the schemas declared for its status. An application error must not reuse a built-in tag (`InvalidInput`, `Unauthenticated`, `Forbidden`); list the built-in error itself instead.
- MCP is unaffected: the native `McpServer` answers invalid arguments itself ([ActionMcp.md](ActionMcp.md)).

## Failure modes

- Route returns 404: the implementation was never passed to a `layer` call, or the path lacks the prefix.
- Type error at `layer`, or `Action "x" is not in this HTTP binding` thrown by it: the implementation's action was not passed to this binding's `make`. Implement the exact contract value the binding received, or add the action to the binding. Matching names and schemas do not establish identity.
- `Duplicate served action: <name>`: one `layer` call received two implementations of the same action.
- `Method 'POST' already declared for route '<prefix>/<action>'` when the host builds: two `layer` calls serve the same action. Serve each action in one call.
- `Duplicate action: <name>` thrown by `make`: two actions share a name, or one action value is listed twice. Rename one, or bind it under another prefix.
- Type error listing `HttpRouter.Request.From<"Requires", CurrentActor>` as unsatisfied: a handler or the hook yields a request service and no middleware provides it. Wrap that `layer` call with the middleware's `.layer`.
- Client method missing for an action: the action is not in the binding.
- 400 `InvalidInput` on a valid-looking request: its `message` names each field that did not decode. Check it, and `Content-Type: application/json`.
- 415: wrong or missing content type.
- Empty 500: a defect, or a handler result that does not match the success schema. The cause is in the server's logs.
- Type error at `layer` naming `before`: the hook fails with something other than `Action.Unauthenticated` or `Action.Forbidden`. Map the failure to a refusal, or declare it on the action and fail in the handler.
