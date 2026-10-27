import { Context, Effect, Schema } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";

export class SignInRequired extends Schema.TaggedError<
  SignInRequired,
  { readonly brand: unique symbol }
>()("SignInRequired", {}) {}

export class Credentials extends Context.Service<
  Credentials,
  { readonly token: Effect.Effect<string, SignInRequired> }
>()("support/Credentials") {}

export const authorize = (request: HttpClientRequest.HttpClientRequest) =>
  Effect.map(
    Effect.flatMap(Credentials, ({ token }) => token),
    (token) => HttpClientRequest.bearerToken(request, token)
  );

export const authorizing = (client: HttpClient.HttpClient) =>
  HttpClient.mapRequestEffect(client, authorize);
