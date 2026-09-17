import { Effect, Layer, Option } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { HttpApiSwagger, OpenApi } from "effect/unstable/httpapi";
import * as ActionMcp from "../src/ActionMcp.js";
import * as Authentication from "../src/Authentication.js";
import { type Actor, CurrentActor, Unauthenticated } from "./auth.js";
import { Http } from "./contracts.js";
import { AuditApp, PublicApp, UserApp } from "./handlers.js";
import { Users } from "./users.js";

/** DEMO ONLY: fixed credentials, not OAuth or a production token verifier. */
export const actors = {
  alice: { id: "alice", tenantId: "acme", permissions: ["users:read", "users:write"] },
  reader: { id: "reader", tenantId: "acme", permissions: ["users:read"] },
  bob: { id: "bob", tenantId: "other", permissions: ["users:read", "users:write"] },
} as const satisfies Readonly<Record<string, Actor>>;

const isActorToken = (token: string): token is keyof typeof actors => Object.hasOwn(actors, token);

const authenticate = (request: HttpServerRequest.HttpServerRequest) => {
  const authorization = request.headers.authorization;
  const token = authorization?.startsWith("Bearer ") ? authorization.slice(7) : "";

  return isActorToken(token) ? Option.some(actors[token]) : Option.none();
};

// Authentication owns error serialization and CurrentActor provision. The host
// keeps its concrete Host/Origin policy at the HTTP boundary.
const authentication = Authentication.middleware(CurrentActor, {
  authenticate: Effect.gen(function* () {
    const actor = authenticate(yield* HttpServerRequest.HttpServerRequest);

    if (Option.isNone(actor)) {
      return yield* new Unauthenticated({ message: "A demo bearer token is required." });
    }

    return actor.value;
  }),
  errors: [Unauthenticated],
  headers: () => ({ "www-authenticate": "Bearer" }),
});

const requestPolicy = HttpRouter.middleware((httpEffect) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = HttpServerRequest.toURL(request.modify({ url: request.originalUrl }));

    if (Option.isNone(url) || !["localhost", "127.0.0.1"].includes(url.value.hostname)) {
      return HttpServerResponse.text("Host not allowed", { status: 403 });
    }

    const origin = request.headers.origin;

    if (origin !== undefined && origin !== url.value.origin) {
      return HttpServerResponse.text("Origin not allowed", { status: 403 });
    }

    return yield* httpEffect;
  }),
);

// One layer per group: middleware provided to a layer applies to that group
// alone. The public group needs no credentials; the user group does.
const http = Layer.mergeAll(
  Http.layer(PublicApp),
  Http.layer(UserApp).pipe(Layer.provide(authentication.layer)),
);

// `Http.api` is a native HttpApi, so documents are Effect's own: the OpenAPI
// JSON as a plain route, and a Swagger UI reading the same contract.
const documentation = Layer.mergeAll(
  HttpRouter.add("GET", "/openapi.json", HttpServerResponse.jsonUnsafe(OpenApi.fromApi(Http.api))),
  HttpApiSwagger.layer(Http.api, { path: "/docs" }),
);

const allowedOrigins = ["http://localhost:3000", "http://127.0.0.1:3000"];

// An MCP endpoint is one route, so its middleware, authentication included,
// covers all of its tools; handlers still authorize each tool themselves. Tools
// that need no credentials at all therefore get their own endpoint, which
// compiles because this implementation requires nothing per request.
const publicMcp = ActionMcp.layer(
  {
    name: "effect-actions-public",
    version: "0.0.0",
    path: "/mcp/public",
    allowedOrigins,
  },
  PublicApp,
);

const mcp = ActionMcp.layer(
  {
    name: "effect-actions",
    version: "0.0.0",
    path: "/mcp",
    allowedOrigins,
  },
  UserApp,
  AuditApp,
).pipe(Layer.provide(authentication.layer));

export const layer = Layer.mergeAll(http, documentation, publicMcp, mcp).pipe(
  Layer.provide(requestPolicy.layer),
  Layer.provide(Users.layerMemory),
);
