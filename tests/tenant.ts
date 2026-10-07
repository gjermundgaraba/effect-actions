// A mixed binding whose verifier reads a request's tenant, which the host's router
// middleware resolves: the fixture of the layer-middleware suite and its type pins.
import { Context, Effect, Redacted, Schema } from "effect";
import { HttpRouter, HttpServerRequest } from "effect/http";
import * as Action from "../src/Action.js";
import * as ActionHttp from "../src/ActionHttp.js";
import * as Authentication from "../src/Authentication.js";

export class Tenant extends Context.Service<Tenant, string>()("tenant/Tenant") {}

export class Actor extends Context.Service<Actor, string>()("tenant/Actor") {}

export const Who = Action.make("who", {
  description: "Name the caller, an identity of the request's tenant",
  readOnly: true,
  caller: Actor,
  success: Schema.String,
});

export const Public = Action.make("public", {
  description: "Answer anyone",
  readOnly: true,
  caller: Action.Anyone,
  success: Schema.String,
});

export const app = Action.implement(
  [Who, Public],
  { who: () => Actor, public: () => Effect.succeed("public") },
  { authorize: Action.allowAll },
);

export const Login = Authentication.make("tenant.Login", Actor);

export const Http = ActionHttp.make([Who, Public], { authentication: Login });

/** A verifier reading a request service, which router middleware provides each request. */
export const authenticate = Authentication.layer(Login, (token: Redacted.Redacted<string>) =>
  Effect.map(Tenant, (tenant) => `${tenant}:${Redacted.value(token)}`),
);

/** The host's router middleware: each request's tenant, from its `x-tenant` header. */
export const resolveTenant = HttpRouter.middleware<{ provides: Tenant }>()((route) =>
  Effect.flatMap(HttpServerRequest.HttpServerRequest, (request) =>
    Effect.provideService(route, Tenant, request.headers["x-tenant"] ?? "default"),
  ),
);
