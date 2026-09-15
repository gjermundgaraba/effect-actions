import { Effect, Layer, Option } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { ActionHttp, ActionMcp } from "../src/index.js";
import { type Actor, CurrentActor, Unauthenticated } from "./auth.js";
import { App } from "./handlers.js";
import { Users } from "./users.js";

/** DEMO ONLY: fixed credentials, not OAuth or a production token verifier. */
export const actors: Readonly<Record<string, Actor>> = {
  alice: { id: "alice", tenantId: "acme", permissions: ["users:read", "users:write"] },
  reader: { id: "reader", tenantId: "acme", permissions: ["users:read"] },
  bob: { id: "bob", tenantId: "other", permissions: ["users:read", "users:write"] },
};

const authenticate = (request: HttpServerRequest.HttpServerRequest) => {
  const authorization = request.headers.authorization;
  const token = authorization?.startsWith("Bearer ") ? authorization.slice(7) : "";
  return Object.hasOwn(actors, token) ? Option.some(actors[token]) : Option.none();
};

const unauthenticated = HttpServerResponse.schemaJson(Unauthenticated);

// Provide CurrentActor to both HTTP and MCP requests.
const Authentication = HttpRouter.middleware<{ provides: CurrentActor }>()((httpEffect) =>
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

    const actor = authenticate(request);
    const response = Option.isNone(actor)
      ? yield* unauthenticated(
          new Unauthenticated({ message: "A demo bearer token is required." }),
          {
            status: 401,
            headers: { "www-authenticate": "Bearer" },
          },
        ).pipe(Effect.orDie)
      : yield* httpEffect.pipe(Effect.provideService(CurrentActor, actor.value));
    // Authenticated responses must never be cached by intermediaries.
    return HttpServerResponse.setHeader(response, "cache-control", "no-store");
  }),
);

export const api = ActionHttp.api(App);

export const layer = Layer.mergeAll(
  ActionHttp.layer(App),
  ActionMcp.layer(App, {
    name: "effect-actions",
    version: "0.0.0",
    allowedOrigins: ["http://localhost:3000", "http://127.0.0.1:3000"],
  }),
).pipe(Layer.provide(Authentication.layer), Layer.provide(Users.layerMemory));
