import { Clock, Data, Duration, Effect, Option, Schema, Stream } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import type { HttpClientResponse } from "effect/http";

import type { CallbackCategory } from "../contract/Event.js";
import { signature } from "./signing.js";

export class AttemptFailed extends Data.TaggedError("AttemptFailed")<{
  readonly category: CallbackCategory;
  readonly final: boolean;
}> {}

export interface Posting {
  readonly url: URL;
  readonly subscriptionId: string;
  readonly webhookId: string;
  readonly body: string;
  readonly keys: readonly Uint8Array[];
}

const timeout = Duration.seconds(5);

const statusCategory = (status: number): CallbackCategory =>
  status >= 500 ? "http_5xx" : "http_4xx";

const outbound = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.flatMap(Effect.serviceOption(FetchHttpClient.RequestInit), (init) =>
    effect.pipe(
      Effect.provideService(FetchHttpClient.RequestInit, {
        ...Option.getOrUndefined(init),
        redirect: "manual",
      }),
      Effect.provideService(HttpClient.TracerPropagationEnabled, false)
    )
  );

const sent = <A>(
  { url, subscriptionId, webhookId, body, keys }: Posting,
  checked: Effect.Effect<void, void>,
  answer: (response: HttpClientResponse.HttpClientResponse) => Effect.Effect<A>
): Effect.Effect<A, AttemptFailed, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const unreached = new AttemptFailed({
      category: "connection_refused",
      final: false,
    });

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
      HttpClientRequest.bodyText(body, "application/json")
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
              })
            )
    );

    return yield* Effect.andThen(
      Effect.mapError(checked, () => unreached),
      outbound(answered)
    ).pipe(
      Effect.timeoutOrElse({
        duration: timeout,
        orElse: () =>
          Effect.fail(new AttemptFailed({ category: "timeout", final: false })),
      }),
      Effect.scoped
    );
  });

export const attempt = (
  posting: Posting,
  checked: Effect.Effect<void, void>
): Effect.Effect<void, AttemptFailed, HttpClient.HttpClient> =>
  sent(posting, checked, () => Effect.void);

const Challenged = Schema.fromJsonString(
  Schema.Struct({ challenge: Schema.String })
);

const challengeAnswerByteLimit = 4096;

const textOf = (response: HttpClientResponse.HttpClientResponse) =>
  Effect.suspend(() => {
    const decoder = new TextDecoder();

    return response.stream.pipe(
      Stream.scan(
        () => ({ bytes: 0, text: "" }),
        ({ bytes, text }, chunk: Uint8Array) => ({
          bytes: bytes + chunk.length,
          text: text + decoder.decode(chunk, { stream: true }),
        })
      ),
      Stream.takeUntil(({ bytes }) => bytes > challengeAnswerByteLimit),
      Stream.runLast,
      Effect.map((last) =>
        Option.map(
          Option.filter(last, ({ bytes }) => bytes <= challengeAnswerByteLimit),
          ({ text }) => text + decoder.decode()
        )
      ),
      Effect.orElseSucceed(() => Option.none<string>())
    );
  });

export const challenged = (
  posting: Posting,
  checked: Effect.Effect<void, void>
): Effect.Effect<string | undefined, AttemptFailed, HttpClient.HttpClient> =>
  sent(posting, checked, (response) =>
    Effect.map(textOf(response), (text) =>
      Option.getOrUndefined(
        Option.map(
          Option.flatMap(text, Schema.decodeUnknownOption(Challenged)),
          ({ challenge }) => challenge
        )
      )
    )
  );
