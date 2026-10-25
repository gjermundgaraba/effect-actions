import { Effect, Match, Option, Predicate, Schema, Stream } from "effect";
import type { HttpClientError, HttpClientResponse } from "effect/http";
import { Sse } from "effect/encoding";
import type * as Action from "../contract/Action.js";
import type { Reporting } from "../contract/progress.js";
import { progressOf } from "./progress.js";

/** The endpoint answered with an HTTP status other than 200, and a body no declared error decodes. */
export class StatusError extends Schema.TaggedError<StatusError>()("StatusError", {
  status: Schema.Int,
  body: Schema.String,
}) {}

/**
 * The endpoint answered with a JSON-RPC error, such as the native server's for an unknown tool.
 */
export class ProtocolError extends Schema.TaggedError<ProtocolError>()("ProtocolError", {
  code: Schema.Finite,
  message: Schema.String,
}) {}

/** The endpoint answered 200 without a JSON-RPC reply to read, as JSON or as an event stream. */
export class NoReply extends Schema.TaggedError<NoReply>()("NoReply", { body: Schema.String }) {}

/** The tool returned an error whose text decodes as none of the action's declared errors. */
export class UndeclaredError extends Schema.TaggedError<UndeclaredError>()("UndeclaredError", {
  text: Schema.String,
}) {}

/** The tool returned a result without the structured content its action's success needs. */
export class NoStructuredContent extends Schema.TaggedError<NoStructuredContent>()(
  "NoStructuredContent",
  {
    body: Schema.String,
  },
) {}

/**
 * The endpoint's event stream held more than `maxEventSize` characters with no frame ending, the
 * most a client holds while it waits for one.
 *
 * **Gotchas**
 *
 * - The limit is on what is held unended, as Effect's SSE parser checks it after each chunk: a frame larger than it that ends within the chunk carrying it is read.
 */
export class FrameTooLarge extends Schema.TaggedError<FrameTooLarge>()("FrameTooLarge", {
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
 * An answer a client method cannot read as the action's success or a declared error: `reason`
 * says which, with what the endpoint sent, so a caller branches on it with
 * `Effect.catchReason("McpCallError", "StatusError", ...)`. `message` names the tool and the
 * reason. Structured content that does not decode as the success is a `SchemaError` instead,
 * and a request that fails an `HttpClientError`.
 *
 * **Gotchas**
 *
 * - `returned an error: Invalid parameters for tool …`, an `UndeclaredError`, from a call its types allowed: the endpoint serves another contract under that name; give `client` the served contract value.
 */
export class McpCallError extends Schema.TaggedError<McpCallError>()("McpCallError", {
  tool: Schema.String,
  reason: Reason,
  message: Schema.String,
}) {}

export const callError = (tool: string, reason: (typeof Reason)["Type"]): McpCallError =>
  new McpCallError({ tool, reason, message: `MCP tools/call "${tool}" ${sentenceOf(reason)}` });

const isEventStream = (response: HttpClientResponse.HttpClientResponse) =>
  (response.headers["content-type"] ?? "").startsWith("text/event-stream");

/**
 * The data of each frame of the event stream `response` is, as it arrives: more than the parser
 * holds with no frame ending fails the call of `tool` with `FrameTooLarge`.
 */
const framesOf = (
  tool: string,
  response: HttpClientResponse.HttpClientResponse,
): Stream.Stream<string, McpCallError | HttpClientError.HttpClientError> =>
  Stream.suspend(() => {
    const data: Array<string> = [];

    const parser = Sse.makeParser((event) => {
      if (Predicate.isTagged(event, "Event")) data.push(event.data);
    });

    return Stream.decodeText(response.stream).pipe(
      Stream.mapEffect((chunk) => {
        const error = parser.feed(chunk);

        return error === undefined
          ? Effect.succeed(data.splice(0))
          : Effect.fail(
              callError(tool, new FrameTooLarge({ maxEventSize: error.reason.maxEventSize })),
            );
      }),
      Stream.flattenIterable,
    );
  });

/**
 * A stateless request's body: its text, and the data of its frames where it is an event stream.
 */
export interface Body {
  readonly text: string;
  readonly frames?: ReadonlyArray<string> | undefined;
}

const framed = (data: string) => `${data.replaceAll(/^/gmu, "data: ")}\n\n`;

/**
 * The body of `response`, read as it arrives: of an event stream, each `notifications/progress`
 * frame hands its value to `sink` and is left out, so a long call holds the frames its reply is
 * read from, not every value it reported. A stateless request's notifications are its own.
 */
export const bodyOf = (
  tool: string,
  response: HttpClientResponse.HttpClientResponse,
  sink?: Reporting,
): Effect.Effect<Body, McpCallError | HttpClientError.HttpClientError> =>
  isEventStream(response)
    ? Effect.map(
        Stream.runCollect(
          Stream.filterEffect(framesOf(tool, response), (data) =>
            Option.match(progressOf(data), {
              onNone: () => Effect.succeed(true),
              onSome: (value) =>
                sink === undefined ? Effect.succeed(false) : Effect.as(sink.progress(value), false),
            }),
          ),
        ),
        (frames) => ({ text: frames.map(framed).join(""), frames }),
      )
    : Effect.map(response.text, (text) => ({ text }));

/**
 * The JSON-RPC reply of a stateless request's body, decoded by `decode`: the body itself, or the
 * last frame `decode` reads of an event stream.
 */
export const replyOf =
  <A>(decode: (data: string) => Option.Option<A>) =>
  ({ text, frames }: Body): Option.Option<A> =>
    frames === undefined
      ? decode(text)
      : Option.fromNullishOr(frames.flatMap((frame) => Option.toArray(decode(frame))).at(-1));

/** Fails with the error of `errors` that `text` decodes as, or with `otherwise`. */
export const failWith = (errors: Action.Errors, text: string, otherwise: McpCallError) =>
  Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.toCodecJson(Schema.Union(errors))))(
    text,
  ).pipe(
    Effect.mapError(() => otherwise),
    Effect.flatMap(Effect.fail),
  );
