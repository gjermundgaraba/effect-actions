import { Schema, Stream } from "effect";
import { Sse } from "effect/encoding";
import { HttpClient, HttpClientRequest } from "effect/http";
import type { Headers, HttpClientResponse } from "effect/http";

export const Json = Schema.fromJsonString(Schema.Json);

export const failureEvent = "effect/http-api/stream/failure";

const eventStream: Headers.Input = { accept: "text/event-stream" };

export const call = (
  name: string,
  body: Schema.Json,
  headers: Headers.Input = eventStream
) =>
  HttpClient.execute(
    HttpClientRequest.post(`/api/${name}`).pipe(
      HttpClientRequest.bodyJsonUnsafe(body),
      HttpClientRequest.setHeaders(headers)
    )
  );

export const framesOf = (
  response: HttpClientResponse.HttpClientResponse,
  count = Number.POSITIVE_INFINITY
) =>
  response.stream.pipe(
    Stream.decodeText,
    Stream.pipeThroughChannel(Sse.decode()),
    Stream.map((frame) => ({
      event: frame.event,
      data: Schema.decodeSync(Json)(frame.data),
    })),
    Stream.take(count),
    Stream.runCollect
  );
