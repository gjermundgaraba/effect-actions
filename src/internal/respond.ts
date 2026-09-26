import { Effect, Schema } from "effect";
import { type HttpEffect, HttpServerResponse } from "effect/unstable/http";
import { type Refusal, refusals, statuses } from "./errors.js";

/**
 * A 401 carries a challenge, as RFC 9110 requires: the plain `Bearer`. An MCP client then
 * finds the authorization server at the well-known URL `protectedResource` serves.
 */
const challenged = (response: HttpServerResponse.HttpServerResponse) =>
  response.status === 401 && response.headers["www-authenticate"] === undefined
    ? HttpServerResponse.setHeader(response, "www-authenticate", "Bearer")
    : response;

/** Challenges every 401 a route answers, whoever answers it. */
export const challenge: HttpEffect.PreResponseHandler = (_request, response) =>
  Effect.succeed(challenged(response));

const Refusals = Schema.Union(refusals);

/** A refusal as its JSON with its status, as every endpoint answers it, challenged if a 401. */
export const refuse = (error: Refusal): Effect.Effect<HttpServerResponse.HttpServerResponse> =>
  HttpServerResponse.schemaJson(Refusals)(error, { status: statuses[error._tag] }).pipe(
    Effect.map(challenged),
    Effect.orDie,
  );
