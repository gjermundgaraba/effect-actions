import { Schema, Stream } from "effect";
import { Sse } from "effect/encoding";
import { type Headers, HttpClient, HttpClientRequest, type HttpClientResponse } from "effect/http";

const Json = Schema.fromJsonString(Schema.Json);

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

export const framesOf = (response: HttpClientResponse.HttpClientResponse) =>
  response.stream.pipe(
    Stream.decodeText,
    Stream.pipeThroughChannel(Sse.decode()),
    Stream.map((frame) => ({
      event: frame.event,
      data: Schema.decodeUnknownSync(Json)(frame.data),
    })),
    Stream.runCollect,
  );
