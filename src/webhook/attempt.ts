import { Clock, Data, Duration, Effect, Option, Schema, Stream } from "effect";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  type HttpClientResponse,
} from "effect/http";
import type { CallbackCategory } from "../contract/Event.js";
import { signature } from "./signing.js";

/**
 * One attempt of a delivery that failed: `category` is SEP-3415's for it, and `final` says a
 * retry would not help, as for a `410 Gone` or a `413 Payload Too Large`.
 */
export class AttemptFailed extends Data.TaggedError("AttemptFailed")<{
  readonly category: CallbackCategory;
  readonly final: boolean;
}> {}

/** What one POST to a callback sends: where, under which subscription and id, signed how. */
export interface Posting {
  readonly url: URL;
  readonly subscriptionId: string;
  readonly webhookId: string;
  readonly body: string;
  readonly keys: ReadonlyArray<Uint8Array>;
}

const timeout = Duration.seconds(5);

const statusCategory = (status: number): CallbackCategory =>
  status >= 500 ? "http_5xx" : "http_4xx";

// Why: Fetch follows redirects unless told not to, and a redirect may lead to an address the
// check never saw, so each POST runs with `redirect: "manual"`, beside the application's own
// `RequestInit`, such as a proxy's dispatcher, and a 3xx answer is a failure; a client that is
// not fetch's follows what it follows, a gotcha on `Webhook.layer`. No trace header is sent: the
// callback is the subscriber's, and the server's traces are not.
const outbound = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.flatMap(Effect.serviceOption(FetchHttpClient.RequestInit), (init) =>
    effect.pipe(
      Effect.provideService(FetchHttpClient.RequestInit, {
        ...Option.getOrUndefined(init),
        redirect: "manual",
      }),
      Effect.provideService(HttpClient.TracerPropagationEnabled, false),
    ),
  );

// Why: an attempt's request lives in its scope, so the body of an answer no one reads, a
// delivery's, is cancelled as the attempt ends rather than left to the garbage collector.
const sent = <A>(
  { url, subscriptionId, webhookId, body, keys }: Posting,
  checked: Effect.Effect<void, void>,
  answer: (response: HttpClientResponse.HttpClientResponse) => Effect.Effect<A>,
): Effect.Effect<A, AttemptFailed, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const unreached = new AttemptFailed({ category: "connection_refused", final: false });
    const timestamp = Math.floor((yield* Clock.currentTimeMillis) / 1000);
    const signed = yield* signature(keys, webhookId, timestamp, body);
    const client = HttpClient.withScope(yield* HttpClient.HttpClient);

    const request = HttpClientRequest.post(url).pipe(
      HttpClientRequest.setHeaders({
        "webhook-id": webhookId,
        "webhook-timestamp": String(timestamp),
        "webhook-signature": signed,
        "x-mcp-subscription-id": subscriptionId,
      }),
      HttpClientRequest.bodyText(body, "application/json"),
    );

    const answered = Effect.flatMap(
      Effect.mapError(client.execute(request), () => unreached),
      (response): Effect.Effect<A, AttemptFailed> =>
        response.status >= 200 && response.status < 300
          ? answer(response)
          : Effect.fail(
              new AttemptFailed({
                category: statusCategory(response.status),
                final: response.status === 410 || response.status === 413,
              }),
            ),
    );

    return yield* Effect.andThen(
      Effect.mapError(checked, () => unreached),
      outbound(answered),
    ).pipe(
      Effect.timeoutOrElse({
        duration: timeout,
        orElse: () => Effect.fail(new AttemptFailed({ category: "timeout", final: false })),
      }),
      Effect.scoped,
    );
  });

/**
 * POSTs `body` to the callback, signed with a fresh timestamp, once `checked`, its address check,
 * passes, and succeeds at a 2xx without reading its body. The timeout bounds the check and the
 * POST together.
 */
export const attempt = (
  posting: Posting,
  checked: Effect.Effect<void, void>,
): Effect.Effect<void, AttemptFailed, HttpClient.HttpClient> =>
  sent(posting, checked, () => Effect.void);

const Challenged = Schema.fromJsonString(Schema.Struct({ challenge: Schema.String }));

// Why: an echoed challenge is a few dozen bytes, so an answer is read this far and no further: a
// callback answering more holds neither the attempt until its timeout nor the server's memory.
// Its bytes are counted as they arrive, not the text they decode to, which holds fewer characters
// than bytes wherever it is not ASCII.
const answerLimit = 4096;

const textOf = (response: HttpClientResponse.HttpClientResponse) =>
  Effect.suspend(() => {
    const decoder = new TextDecoder();

    return response.stream.pipe(
      Stream.scan(
        () => ({ bytes: 0, text: "" }),
        ({ bytes, text }, chunk: Uint8Array) => ({
          bytes: bytes + chunk.length,
          text: text + decoder.decode(chunk, { stream: true }),
        }),
      ),
      Stream.takeUntil(({ bytes }) => bytes > answerLimit),
      Stream.runLast,
      Effect.map((last) =>
        Option.map(
          Option.filter(last, ({ bytes }) => bytes <= answerLimit),
          ({ text }) => text + decoder.decode(),
        ),
      ),
      Effect.orElseSucceed(() => Option.none<string>()),
    );
  });

/**
 * `attempt` of a verification: the challenge its 2xx answer echoes, where its first 4 KiB hold
 * one.
 */
export const challenged = (
  posting: Posting,
  checked: Effect.Effect<void, void>,
): Effect.Effect<string | undefined, AttemptFailed, HttpClient.HttpClient> =>
  sent(posting, checked, (response) =>
    Effect.map(textOf(response), (text) =>
      Option.getOrUndefined(
        Option.map(
          Option.flatMap(text, Schema.decodeUnknownOption(Challenged)),
          ({ challenge }) => challenge,
        ),
      ),
    ),
  );
