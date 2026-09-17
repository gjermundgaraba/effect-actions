import { Effect, Layer, Option } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { ActionMcp, Authentication } from "../src/index.js";
import { type Actor, CurrentActor, Unauthenticated } from "./auth.js";
import { Http } from "./contracts.js";
import { App } from "./handlers.js";
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

export const layer = Layer.mergeAll(
  Http.layer(App, { openapiPath: "/openapi.json" }),
  ActionMcp.layer(App, {
    name: "effect-actions",
    version: "0.0.0",
    path: "/mcp",
    allowedOrigins: ["http://localhost:3000", "http://127.0.0.1:3000"],
  }),
).pipe(
  Layer.provide(authentication.combine(requestPolicy).layer),
  Layer.provide(Users.layerMemory),
);
