import { Effect, Layer } from "effect";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  type HttpRouter,
  type HttpServer,
} from "effect/unstable/http";

/** What in-memory routes may leave to the host: the router, the platform, nothing per request. */
export type Served =
  | HttpRouter.HttpRouter
  | HttpRouter.Request<"Requires", never>
  | HttpRouter.Request<"GlobalRequires", never>
  | HttpRouter.Request<"Error", any>
  | HttpRouter.Request<"GlobalError", any>
  | Layer.Success<typeof HttpServer.layerServices>;

/** Where relative request URLs resolve, so a client needs no `baseUrl`. */
const origin = "http://localhost";

/**
 * The native `HttpClient`, sending every request to `handler` instead of the network. A
 * relative URL resolves against `http://localhost`.
 */
export const clientOf = (
  handler: (request: Request) => Promise<Response>,
): Layer.Layer<HttpClient.HttpClient> =>
  Layer.effect(
    HttpClient.HttpClient,
    Effect.map(
      HttpClient.HttpClient,
      HttpClient.mapRequest((request) =>
        request.url.startsWith("/") ? HttpClientRequest.prependUrl(request, origin) : request,
      ),
    ),
  ).pipe(
    Layer.provide(FetchHttpClient.layer),
    Layer.provide(
      Layer.succeed(FetchHttpClient.Fetch, (input, init) => handler(new Request(input, init))),
    ),
  );
