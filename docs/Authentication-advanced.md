# Authentication beyond a bearer token

A verifier reading the request, an API key or a cookie, a route of your own, a policy before authentication, and a refusal outside the router.

A message the library throws says its fix; for a compiler diagnostic or Effect's own error, search [Authentication-failures.md](Authentication-failures.md). For one symbol, `grep -rn <symbol> node_modules/@gjermundgaraba/effect-actions/dist/`: each declaration's JSDoc carries its rules and gotchas, and this page only what an example cannot show.

## Read request context in a verifier

A verifier may read per-request services: the request, or one of your own, such as the tenant a request addresses, which native router middleware provides:

```ts example=kitchen-sink/src/workspaces/tenant.ts
import { Context, Effect, Option } from "effect";
import { HttpRouter, HttpServerRequest } from "effect/http";

/**
 * The workspace a request addresses, from its `X-Workspace` header. It is request context, not
 * an identity: the verifier reads it to decide which of an account's memberships the caller
 * acts in. Handlers never read it; they read the workspace of the authenticated member.
 */
export class Tenant extends Context.Service<Tenant, Option.Option<string>>()(
  "tracker/Tenant"
) {}

// Native router middleware. It provides `Tenant` to whatever it is provided to, per request:
// to the verifier too, when it is provided after the authentication, in a `Layer.provide` of
// its own: in one array with the authentication it would leave `Tenant` owed, since an array's
// layers provide to the routes, not to one another.
export const resolveTenant = HttpRouter.middleware<{ provides: Tenant }>()(
  (route) =>
    Effect.flatMap(HttpServerRequest.HttpServerRequest, (request) =>
      Effect.provideService(
        route,
        Tenant,
        Option.fromNullishOr(request.headers["x-workspace"])
      )
    )
);
```

The verifier reading it is `authenticateBearer` in [kitchen-sink/src/identity/authenticate.ts](../examples/kitchen-sink/src/identity/authenticate.ts), and `publicRoutes` in [kitchen-sink/src/routes.ts](../examples/kitchen-sink/src/routes.ts) provides the middleware.

## Use a scheme other than Bearer

Name the scheme in `Authentication.Options.security`, whose JSDoc says what each scheme gives up. See `Session` in [kitchen-sink/src/identity/Identity.ts](../examples/kitchen-sink/src/identity/Identity.ts) and `authenticateSession` in [kitchen-sink/src/identity/authenticate.ts](../examples/kitchen-sink/src/identity/authenticate.ts) for a session cookie beside Bearer, and [kitchen-sink/src/admin/Admin.ts](../examples/kitchen-sink/src/admin/Admin.ts) and [kitchen-sink/src/admin/authenticate.ts](../examples/kitchen-sink/src/admin/authenticate.ts) for an API key in a header.

For a cookie covering rpcs over a WebSocket, see [ActionRpc.md](ActionRpc.md#send-request-context-with-a-call). A scheme the deployment decides, such as a cookie name a framework prefixes over HTTPS, is still one declaration, as `Authentication.layer` says.

## Protect a route of your own

A route of the host's own, such as a download or a WebSocket upgrade, takes `Authentication.protect(descriptor)`, whose rules, authorization and caching included, are on its JSDoc:

```ts example=kitchen-sink/src/attachments/download.ts
import * as Authentication from "@gjermundgaraba/effect-actions/Authentication";
import { Effect, Layer } from "effect";
import { HttpRouter, HttpServerResponse } from "effect/http";

import { authorize } from "../identity/authorize.js";
import { CurrentMember, Session } from "../identity/Identity.js";
import { GetAttachment } from "./Attachments.js";
import { AttachmentStore } from "./store.js";

// A route of the host's own: `GET /attachments/<id>` answers the image's bytes, for an `<img>`
// of the web app, which no action can (an action answers JSON), behind
// `Authentication.protect(Session)`: the page's cookie, which the web app's rpcs use. A token
// holder has no use for it: `getAttachment` gives an API client the same image.
export const download = Layer.unwrap(
  Effect.map(AttachmentStore, (store) =>
    HttpRouter.add(
      "GET",
      "/attachments/:id",
      Effect.gen(function* () {
        // The rule of the action it mirrors.
        yield* authorize(GetAttachment);

        const member = yield* CurrentMember;
        const { id = "" } = yield* HttpRouter.params;
        const { image } = yield* store.get(member.workspace, id);

        // An attachment never changes, but it is one workspace's: `private`.
        return HttpServerResponse.uint8Array(image.data, {
          contentType: image.mimeType,
          headers: {
            "cache-control": "private, max-age=31536000, immutable",
            // What a member uploaded is served from the application's own origin, and an image
            // can be a document: an SVG opened by its URL, not in an `<img>`, runs its scripts
            // as the member reading it. `sandbox` gives it no origin and no scripts, and
            // `nosniff` keeps the browser to the type stated.
            "content-security-policy": "sandbox",
            "x-content-type-options": "nosniff",
          },
        });
      }).pipe(
        Effect.catchTag("AttachmentNotFound", () =>
          Effect.succeed(HttpServerResponse.empty({ status: 404 }))
        )
      )
    ).pipe(Layer.provide(Authentication.protect(Session).layer))
  )
);
```

[kitchen-sink/test/attachments/attachments.test.ts](../examples/kitchen-sink/test/attachments/attachments.test.ts) asserts what it answers.

## Run a request policy before authentication

For a check that must refuse a request before its credential is read, such as a `Host` or `Origin` allowlist, make global router middleware, `HttpRouter.middleware(check, { global: true })`, and provide it in the last `Layer.provide`:

```ts example=kitchen-sink/src/request-policy.ts
import { Effect, Layer, Option } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import { allowedOrigins, publicUrl } from "./config.js";

const loopback = ["localhost", "127.0.0.1"];

// Which Host and Origin a request may carry: not the library's concern, but every request of
// both ports passes it first. A Host that is neither loopback nor the public URL's is refused,
// against DNS rebinding. The web app signs in with a cookie, which a browser attaches to
// any page's request, so a foreign Origin must be refused before authentication reads it.
// That is why this is global router middleware (`global: true`): it runs before routing, so
// before every route's authentication. As a layer's own `middleware` it would run inside the
// authentication, too late.
export const requestPolicy = HttpRouter.middleware(
  Effect.gen(function* () {
    const hosts = new Set([...loopback, new URL(yield* publicUrl).hostname]);
    const origins = yield* allowedOrigins;

    return (httpEffect) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;

        const url = HttpServerRequest.toURL(
          request.modify({ url: request.originalUrl })
        );

        if (Option.isNone(url) || !hosts.has(url.value.hostname)) {
          return HttpServerResponse.text("Host not allowed", { status: 403 });
        }

        const { origin } = request.headers;

        // The request's own origin is that of a page served from this port directly. Behind a
        // proxy ending TLS it is an `http:` one from Effect 4.0.6, whose `originalUrl` takes the
        // scheme of the connection, whatever `X-Forwarded-Proto` says, so the public URL's
        // origin is among `origins`.
        if (
          origin !== undefined &&
          origin !== url.value.origin &&
          !origins.includes(origin)
        ) {
          return HttpServerResponse.text("Origin not allowed", { status: 403 });
        }

        return yield* httpEffect;
      });
  }),
  { global: true }
);

// CORS for the one cross-origin caller, a browser MCP client. `HttpRouter.cors` is global to
// the router too: it answers the preflight before any route's authentication, and adds its
// headers to refusals as well. An MCP endpoint's `allowedOrigins` is no CORS: it only refuses
// origins. The headers are those an MCP client sends and must be able to read. A client of an
// MCP revision with sessions sends its session's id on each request, reads it from the answer
// that opened the session, and ends the session with a `DELETE`.
export const cors = Layer.unwrap(
  Effect.map(allowedOrigins, (origins) =>
    HttpRouter.cors({
      allowedOrigins: origins,
      allowedMethods: ["POST", "DELETE"],
      allowedHeaders: [
        "Content-Type",
        "Authorization",
        "X-Workspace",
        "MCP-Protocol-Version",
        "MCP-Method",
        "MCP-Name",
        "Mcp-Session-Id",
      ],
      exposedHeaders: [
        "WWW-Authenticate",
        "MCP-Protocol-Version",
        "Mcp-Session-Id",
      ],
    })
  )
);
```

See `publicRoutes` in [kitchen-sink/src/routes.ts](../examples/kitchen-sink/src/routes.ts); [kitchen-sink/test/request-policy.test.ts](../examples/kitchen-sink/test/request-policy.test.ts) asserts it.

## Refuse outside the router

For a caller the router never routes, such as a Node `upgrade` handler admitting a socket, read the token with `Authentication.bearerTokenOf` and answer a refusal with `Authentication.refusalResponse`, whose JSDoc holds the rest.
