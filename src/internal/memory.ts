import { Effect, Layer } from "effect";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  type HttpRouter,
  type HttpServer,
} from "effect/http";

/** What in-memory routes may leave to the host: the router, the platform, nothing per request. */
export type Served =
  | HttpRouter.HttpRouter
  | HttpRouter.Request<"Requires", never>
  | HttpRouter.Request<"GlobalRequires", never>
  | HttpRouter.Request<"Error", any>
  | HttpRouter.Request<"GlobalError", any>
  | Layer.Success<typeof HttpServer.layerServices>;

/** Where relative request URLs resolve, so a client needs no `baseUrl`. */
const origin = "http://localhost/";

/**
 * The native `HttpClient`, sending every request to `handler` instead of the network. A
 * relative URL resolves against `http://localhost/`, as a page there would resolve it, and a
 * request carries the `Host` header of its URL, as one over the network does.
 */
export const clientOf = (
  handler: (request: Request) => Promise<Response>,
): Layer.Layer<HttpClient.HttpClient> =>
  Layer.effect(
    HttpClient.HttpClient,
    Effect.map(HttpClient.HttpClient, (fetch) =>
      // Resolved once every mapping of the request has run, a client's `baseUrl` included,
      // so only a URL still relative takes the origin. One that resolves to nothing, such as
      // `http://`, is left to the native client's typed `InvalidUrlError`.
      HttpClient.makeWith(
        (request) =>
          fetch.postprocess(
            Effect.map(request, (mapped) => {
              const resolved = URL.canParse(mapped.url) ? null : URL.parse(mapped.url, origin);

              return resolved === null ? mapped : HttpClientRequest.setUrl(mapped, resolved.href);
            }),
          ),
        fetch.preprocess,
      ),
    ),
  ).pipe(
    Layer.provide(FetchHttpClient.layer),
    Layer.provide(
      Layer.succeed(FetchHttpClient.Fetch, (input, init) => {
        const request = new Request(input, init);

        // The network sets it, so middleware checking the host, as against DNS rebinding,
        // sees one in memory too; one the caller gives is kept.
        if (!request.headers.has("host")) request.headers.set("host", new URL(request.url).host);

        return handler(request);
      }),
    ),
  );
