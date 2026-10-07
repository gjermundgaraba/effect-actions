import { Effect, Layer, Predicate, Stream } from "effect";
import {
  FetchHttpClient,
  HttpBody,
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
 * `request`, a streamed body turned into a web stream in the current context. The native client
 * turns it in its send, under the in-memory `fetch`, where another client the stream calls
 * would send to the routes too.
 */
const pulled = (request: HttpClientRequest.HttpClientRequest) => {
  const body = request.body;

  if (!Predicate.isTagged(body, "Stream")) return Effect.succeed(request);

  return Effect.map(Stream.toReadableStreamEffect(body.stream), (readable) =>
    HttpClientRequest.setBody(
      request,
      HttpBody.raw(readable, { contentType: body.contentType, contentLength: body.contentLength }),
    ).pipe(HttpClientRequest.updateHeaders(() => request.headers)),
  );
};

/**
 * The native `HttpClient`, sending every request to `handler` instead of the network. A
 * relative URL resolves against `http://localhost/`, as a page there would resolve it, and a
 * request carries the `Host` header of its URL, as one over the network does. The client is
 * its own: the program's other clients keep their `fetch`, and get none of its requests.
 */
export const clientOf = (
  handler: (request: Request) => Promise<Response>,
): Layer.Layer<HttpClient.HttpClient> => {
  const fetch: typeof globalThis.fetch = (input, init) => {
    const request = new Request(input, init);

    // The network sets it, so middleware checking the host, as against DNS rebinding, sees
    // one in memory too; one the caller gives is kept.
    if (!request.headers.has("host")) request.headers.set("host", new URL(request.url).host);

    return handler(request);
  };

  // `FetchHttpClient.layer` is one memoized layer, which captures the context it is built
  // in: shared with another layer of the program, one would send the other's requests, so
  // this one is built fresh. Its `fetch` is set on each request, around the send alone: a
  // `FetchHttpClient.Fetch` the program provides around a request wins over one captured at
  // build, and another client that a mapping of the request, or its streamed body, calls
  // keeps its own.
  return Layer.effect(
    HttpClient.HttpClient,
    Effect.map(HttpClient.HttpClient, (native) =>
      HttpClient.makeWith(
        (request) =>
          Effect.flatMap(request, (mapped) => {
            // Resolved once every mapping of the request has run, a client's `baseUrl`
            // included, so only a URL still relative takes the origin. One that resolves to
            // nothing, such as `http://`, is left to the native client's typed
            // `InvalidUrlError`.
            const resolved = URL.canParse(mapped.url) ? null : URL.parse(mapped.url, origin);

            const sent =
              resolved === null ? mapped : HttpClientRequest.setUrl(mapped, resolved.href);

            return Effect.flatMap(pulled(sent), (ready) =>
              native
                .postprocess(Effect.succeed(ready))
                .pipe(Effect.provideService(FetchHttpClient.Fetch, fetch)),
            );
          }),
        native.preprocess,
      ),
    ),
  ).pipe(Layer.provide(Layer.fresh(FetchHttpClient.layer)));
};
