import { Effect, Match, Option, Predicate, Schema, Stream } from "effect";
import { Sse } from "effect/encoding";
import type { HttpClientError, HttpClientResponse } from "effect/http";

import type * as Action from "../contract/Action.js";
import type { Reporting } from "../contract/progress.js";
import { progressOf } from "./progress.js";

/** The endpoint answered with an HTTP status other than 200, and a body no declared error decodes. */
export class StatusError extends Schema.TaggedError<
  StatusError,
  { readonly brand: unique symbol }
>()("StatusError", {
  status: Schema.Int,
  body: Schema.String,
}) {}

/**
 * The endpoint answered with a JSON-RPC error, such as the native server's for an unknown tool.
 */
export class ProtocolError extends Schema.TaggedError<
  ProtocolError,
  { readonly brand: unique symbol }
>()("ProtocolError", {
  code: Schema.Finite,
  message: Schema.String,
}) {}

/** The endpoint answered 200 without a JSON-RPC reply to read, as JSON or as an event stream. */
export class NoReply extends Schema.TaggedError<
  NoReply,
  { readonly brand: unique symbol }
>()("NoReply", {
  body: Schema.String,
}) {}

/** The tool returned an error whose text decodes as none of the action's declared errors. */
export class UndeclaredError extends Schema.TaggedError<
  UndeclaredError,
  { readonly brand: unique symbol }
>()("UndeclaredError", {
  text: Schema.String,
}) {}

/** The tool returned a result without the structured content its action's success needs. */
export class NoStructuredContent extends Schema.TaggedError<
  NoStructuredContent,
  { readonly brand: unique symbol }
>()("NoStructuredContent", {
  body: Schema.String,
}) {}

/**
 * The endpoint's event stream held more than `maxEventSize` characters with no frame ending, the
 * most a client holds while it waits for one.
 *
 * **Gotchas**
 *
 * - The limit is on what is held unended, as Effect's SSE parser checks it after each chunk: a frame larger than it that ends within the chunk carrying it is read.
 */
export class FrameTooLarge extends Schema.TaggedError<
  FrameTooLarge,
  { readonly brand: unique symbol }
>()("FrameTooLarge", {
  maxEventSize: Schema.Int,
}) {}

const Reason = Schema.Union([
  StatusError,
  ProtocolError,
  NoReply,
  UndeclaredError,
  NoStructuredContent,
  FrameTooLarge,
]);

const sentenceOf = Match.typeTags<(typeof Reason)["Type"], string>()({
  StatusError: ({ status, body }) => `answered ${status}: ${body}`,
  ProtocolError: ({ code, message }) => `failed with ${code}: ${message}`,
  NoReply: ({ body }) => `had no reply: ${body}`,
  UndeclaredError: ({ text }) => `returned an error: ${text}`,
  NoStructuredContent: ({ body }) => `returned no structured content: ${body}`,
  FrameTooLarge: ({ maxEventSize }) =>
    `sent more than ${maxEventSize} characters of an event stream with no frame ending`,
});

/**
 * An answer a client cannot read as the contract's: `method` is the request, `tools/call` or an
 * `events/*` one, `target` the tool or event it named, and `reason` says what was wrong, with what
 * the endpoint sent, so a caller branches on it with
 * `Effect.catchReason("McpCallError", "StatusError", ...)`. `message` names all three.
 * Structured content that does not decode as the success is a `SchemaError` instead, and a
 * request that fails an `HttpClientError`.
 *
 * **Gotchas**
 *
 * - `returned an error: Invalid parameters for tool …`, an `UndeclaredError`, from a call its types allowed: the endpoint serves another contract under that name; give `client` the served contract value.
 */
export class McpCallError extends Schema.TaggedError<
  McpCallError,
  { readonly brand: unique symbol }
>()("McpCallError", {
  method: Schema.String,
  target: Schema.String,
  reason: Reason,
  message: Schema.String,
}) {}

export const callError = (
  method: string,
  target: string,
  reason: (typeof Reason)["Type"]
): McpCallError =>
  new McpCallError({
    method,
    target,
    reason,
    message: `MCP ${method} "${target}" ${sentenceOf(reason)}`,
  });

export const isEventStream = (
  response: HttpClientResponse.HttpClientResponse
) => (response.headers["content-type"] ?? "").startsWith("text/event-stream");

// Why: The parser fed by hand, not `Sse.decode`, which fails with `Retry` once it reads a
// `retry:` directive and stops reading: one sent before a reply would lose the reply, and a watch,
// which sets its own reconnect delay, would reconnect to it in a loop.
/**
 * The data of each frame of the event stream `response` is, as it arrives: more than the parser
 * holds with no frame ending fails `method` on `name` with `FrameTooLarge`.
 */
export const framesOf = (
  method: string,
  name: string,
  response: HttpClientResponse.HttpClientResponse
): Stream.Stream<string, McpCallError | HttpClientError.HttpClientError> =>
  Stream.suspend(() => {
    const data: string[] = [];

    const parser = Sse.makeParser((event) => {
      if (Predicate.isTagged(event, "Event")) {
        data.push(event.data);
      }
    });

    return Stream.decodeText(response.stream).pipe(
      Stream.mapEffect((chunk) => {
        const error = parser.feed(chunk);

        return error === undefined
          ? Effect.succeed(data.splice(0))
          : Effect.fail(
              callError(
                method,
                name,
                new FrameTooLarge({ maxEventSize: error.reason.maxEventSize })
              )
            );
      }),
      Stream.flattenIterable
    );
  });

/**
 * The messages of `response`, read as it arrives: the data of each frame of an event stream, or
 * the body itself as one. Each `notifications/progress` frame hands its value to `sink` and is
 * left out, so a long call holds the frames its reply is read from, not every value it reported.
 * A stateless request's notifications are its own.
 */
export const bodyOf = (
  method: string,
  name: string,
  response: HttpClientResponse.HttpClientResponse,
  sink?: Reporting
): Effect.Effect<
  readonly string[],
  McpCallError | HttpClientError.HttpClientError
> =>
  isEventStream(response)
    ? Stream.runCollect(
        Stream.filterEffect(framesOf(method, name, response), (data) =>
          Option.match(progressOf(data), {
            onNone: () => Effect.succeed(true),
            onSome: (value) =>
              sink === undefined
                ? Effect.succeed(false)
                : Effect.as(sink.progress(value), false),
          })
        )
      )
    : Effect.map(response.text, (text) => [text]);

/** Fails with the error of `errors` that `text` decodes as, or with `otherwise`. */
export const failWith = (
  errors: Action.Errors,
  text: string,
  otherwise: McpCallError
) =>
  Schema.decodeEffect(
    Schema.fromJsonString(Schema.toCodecJson(Schema.Union(errors)))
  )(text).pipe(
    Effect.mapError(() => otherwise),
    Effect.flatMap(Effect.fail)
  );
