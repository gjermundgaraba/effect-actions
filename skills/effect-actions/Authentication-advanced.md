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

The verifier reading it is `authenticateBearer` in [kitchen-sink/src/identity/authenticate.ts](node_modules/@gjermundgaraba/effect-actions/examples/kitchen-sink/src/identity/authenticate.ts), and `publicRoutes` in [kitchen-sink/src/routes.ts](node_modules/@gjermundgaraba/effect-actions/examples/kitchen-sink/src/routes.ts) provides the middleware.

## Use a scheme other than Bearer

Name the scheme in `Authentication.Options.security`, whose JSDoc says what each scheme gives up. See `Session` in [kitchen-sink/src/identity/Identity.ts](node_modules/@gjermundgaraba/effect-actions/examples/kitchen-sink/src/identity/Identity.ts) and `authenticateSession` in [kitchen-sink/src/identity/authenticate.ts](node_modules/@gjermundgaraba/effect-actions/examples/kitchen-sink/src/identity/authenticate.ts) for a session cookie beside Bearer, and [kitchen-sink/src/admin/Admin.ts](node_modules/@gjermundgaraba/effect-actions/examples/kitchen-sink/src/admin/Admin.ts) and [kitchen-sink/src/admin/authenticate.ts](node_modules/@gjermundgaraba/effect-actions/examples/kitchen-sink/src/admin/authenticate.ts) for an API key in a header.

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

export const download = Layer.unwrap(
  Effect.map(AttachmentStore, (store) =>
    HttpRouter.add(
      "GET",
      "/attachments/:id",
      Effect.gen(function* () {
        yield* authorize(GetAttachment);

        const member = yield* CurrentMember;
        const { id = "" } = yield* HttpRouter.params;
        const { image } = yield* store.get(member.workspace, id);

        return HttpServerResponse.uint8Array(image.data, {
          contentType: image.mimeType,
          headers: {
            "cache-control": "private, max-age=31536000, immutable",
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

[kitchen-sink/test/attachments/attachments.test.ts](node_modules/@gjermundgaraba/effect-actions/examples/kitchen-sink/test/attachments/attachments.test.ts) asserts what it answers.

## Run a request policy before authentication

For a check that must refuse a request before its credential is read, such as a `Host` or `Origin` allowlist, make global router middleware, `HttpRouter.middleware(check, { global: true })`, and provide it in the last `Layer.provide`:

```ts example=kitchen-sink/src/request-policy.ts
import { Effect, Layer, Option } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import { allowedOrigins, publicUrl } from "./config.js";

const loopback = ["localhost", "127.0.0.1"];

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

See `publicRoutes` in [kitchen-sink/src/routes.ts](node_modules/@gjermundgaraba/effect-actions/examples/kitchen-sink/src/routes.ts); [kitchen-sink/test/request-policy.test.ts](node_modules/@gjermundgaraba/effect-actions/examples/kitchen-sink/test/request-policy.test.ts) asserts it.

## Refuse outside the router

For a caller the router never routes, such as a Node `upgrade` handler admitting a socket, read the token with `Authentication.bearerTokenOf` and answer a refusal with `Authentication.refusalResponse`, whose JSDoc holds the rest.
