import { Effect, Layer, Predicate, Stream } from "effect";
import {
  FetchHttpClient,
  HttpBody,
  HttpClient,
  HttpClientRequest,
} from "effect/http";
import type { HttpRouter, HttpServer } from "effect/http";

/** What in-memory routes may leave to the host: the router, the platform, nothing per request. */
export type Served =
  | HttpRouter.HttpRouter
  | HttpRouter.Request<"Requires", never>
  | HttpRouter.Request<"GlobalRequires", never>
  | HttpRouter.Request<"Error", unknown>
  | HttpRouter.Request<"GlobalError", unknown>
  | Layer.Success<typeof HttpServer.layerServices>;

const relativeUrlOrigin = "http://localhost/";

const withWebStreamBodyInCurrentContext = (
  request: HttpClientRequest.HttpClientRequest
) => {
  const { body } = request;

  if (!Predicate.isTagged(body, "Stream")) {
    return Effect.succeed(request);
  }

  return Effect.map(Stream.toReadableStreamEffect(body.stream), (readable) =>
    HttpClientRequest.setBody(
      request,
      HttpBody.raw(readable, {
        contentType: body.contentType,
        contentLength: body.contentLength,
      })
    ).pipe(HttpClientRequest.updateHeaders(() => request.headers))
  );
};

export const clientOf = (
  handler: (request: Request) => Promise<Response>
): Layer.Layer<HttpClient.HttpClient> => {
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);

    if (!request.headers.has("host")) {
      request.headers.set("host", new URL(request.url).host);
    }

    return await handler(request);
  };

  return Layer.effect(
    HttpClient.HttpClient,
    Effect.map(HttpClient.HttpClient, (native) =>
      HttpClient.makeWith(
        (request) =>
          Effect.flatMap(request, (mapped) => {
            const resolved = URL.canParse(mapped.url)
              ? null
              : URL.parse(mapped.url, relativeUrlOrigin);

            const sent =
              resolved === null
                ? mapped
                : HttpClientRequest.setUrl(mapped, resolved.href);

            return Effect.flatMap(
              withWebStreamBodyInCurrentContext(sent),
              (ready) =>
                native
                  .postprocess(Effect.succeed(ready))
                  .pipe(Effect.provideService(FetchHttpClient.Fetch, fetch))
            );
          }),
        native.preprocess
      )
    )
  ).pipe(Layer.provide(Layer.fresh(FetchHttpClient.layer)));
};
