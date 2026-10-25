import { Schema, Stream } from "effect";
import { Sse } from "effect/encoding";
import { type Headers, HttpClient, HttpClientRequest, type HttpClientResponse } from "effect/http";

export const Json = Schema.fromJsonString(Schema.Json);

export const failureEvent = "effect/http-api/stream/failure";

export const call = (
  name: string,
  body: Schema.Json,
  headers: Headers.Input = { accept: "text/event-stream" },
) =>
  HttpClient.execute(
    HttpClientRequest.post(`/api/${name}`).pipe(
      HttpClientRequest.bodyJsonUnsafe(body),
      HttpClientRequest.setHeaders(headers),
    ),
  );

/** A response's SSE frames, each `data` decoded as JSON: every one, or the first `count`. */
export const framesOf = (
  response: HttpClientResponse.HttpClientResponse,
  count = Number.POSITIVE_INFINITY,
) =>
  response.stream.pipe(
    Stream.decodeText,
    Stream.pipeThroughChannel(Sse.decode()),
    Stream.map((frame) => ({
      event: frame.event,
      data: Schema.decodeUnknownSync(Json)(frame.data),
    })),
    Stream.take(count),
    Stream.runCollect,
  );
