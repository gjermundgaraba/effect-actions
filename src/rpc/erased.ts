import {
  Cause,
  Effect,
  ErrorReporter,
  Match,
  Option,
  Predicate,
  Queue,
  Result,
  Schema,
  SchemaTransformation,
  Stream,
} from "effect";
import { HttpClientRequest, HttpServerRequest } from "effect/http";
import type { Headers } from "effect/http";
import { HttpApiBuilder } from "effect/http-api";
import { Rpc, RpcGroup } from "effect/rpc";
import type { RpcMiddleware, RpcMessage } from "effect/rpc";

import { providerOf } from "../authentication/provider.js";
import type { Any as Authentication } from "../authentication/provider.js";
import type * as Action from "../contract/Action.js";
import { decodeInput } from "../contract/call.js";
import { Anyone } from "../contract/caller.js";
import type { Codec } from "../contract/codec.js";
import { bindingErrors, eventErrors } from "../contract/declared.js";
import type { Declaring } from "../contract/declared.js";
import type * as Event from "../contract/Event.js";
import { acquireFeeds } from "../contract/feed.js";
import type { AnyEventImplementation, Feed } from "../contract/feed.js";
import { acquire, elementsOf } from "../contract/implementation.js";
import type {
  AnyImplementation,
  ErasedHandler,
  ErasedValue,
} from "../contract/implementation.js";
import type { Reporting, Progressed } from "../contract/progress.js";
import { PushedOf, queuedPush, SubscriptionOf } from "../contract/push.js";
import { concealed } from "../contract/reported.js";
import { answeringOf, Answering } from "../contract/stream.js";

export const streams = (action: Action.Any) =>
  !Answering.$is("Value")(answeringOf(action));

const withSyntheticRequestFromHeaders =
  (headers: Headers.Headers) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provideService(
        HttpServerRequest.HttpServerRequest,
        HttpServerRequest.fromClientRequest(
          HttpClientRequest.get("/", { headers })
        )
      ),
      Effect.provideService(HttpServerRequest.ParsedSearchParams, {})
    );

type CallOptions = Parameters<
  RpcMiddleware.RpcMiddleware<never, never, never>
>[1];

type Step = (
  effect: Effect.Effect<unknown, unknown, unknown>,
  options: CallOptions
) => Effect.Effect<unknown, unknown, unknown>;

const throughSteps = <A, R>(
  steps: readonly Step[],
  call: Effect.Effect<A, unknown, R>,
  options: CallOptions
) => {
  let wrapped: Effect.Effect<unknown, unknown, unknown> = call;

  for (const step of steps) {
    const inner = wrapped;

    wrapped = Effect.suspend(() => step(inner, options));
  }

  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return wrapped as Effect.Effect<A, unknown, R>;
};

const authenticatingOf = (authentication: Authentication) =>
  Effect.map(providerOf(authentication), (provider) => {
    const verify = Effect.flatMap(
      HttpApiBuilder.securityDecode(authentication.security),
      provider.authenticate
    );

    return (
      verifying: (verify: Verification, options: CallOptions) => Verification
    ): Step =>
      (effect, options) =>
        Effect.flatMap(verifying(verify, options), (actor) =>
          Effect.provideService(effect, authentication.identity, actor)
        );
  });

type Verification = Effect.Effect<unknown, unknown, unknown>;

export class DeclaredFailure {
  readonly [ErrorReporter.ignore] = true;
  readonly json: Schema.Json;

  constructor(json: Schema.Json) {
    this.json = json;
  }

  toString() {
    return Predicate.isString(this.json)
      ? this.json
      : JSON.stringify(this.json);
  }
}

const asJson = () =>
  Schema.link<DeclaredFailure>()(
    Schema.Json,
    SchemaTransformation.transform({
      decode: (json) => new DeclaredFailure(json),
      encode: (failure) => failure.json,
    })
  );

const Declared = Schema.instanceOf(DeclaredFailure, {
  toCodecJson: asJson,
  toCodecIso: asJson,
});

const streamOf = (name: string) =>
  Rpc.make(name, {
    payload: Schema.Json,
    success: Schema.Json,
    error: Declared,
    stream: true,
  });

export const erasedOf = (
  actions: readonly Action.Any[],
  events: readonly Event.Any[]
) =>
  RpcGroup.make(
    ...actions.map((action) =>
      streams(action)
        ? streamOf(action.name)
        : Rpc.make(action.name, {
            payload: Schema.Json,
            success: Schema.Json,
            error: Declared,
          })
    ),
    ...events.map((event) => streamOf(event.name))
  );

const callBoundaryOf = (error: Schema.Union<Action.Errors>) => {
  const encode = Schema.encodeUnknownEffect(Schema.toCodecJson(error));

  return <A, R>(
    effect: Effect.Effect<A, unknown, R>
  ): Effect.Effect<A, DeclaredFailure, R> =>
    Effect.catchCause(effect, (cause) => {
      if (Cause.hasDies(cause)) {
        return concealed(cause);
      }

      const failure = Cause.findFail(cause);

      return Result.isSuccess(failure)
        ? encode(failure.success.error).pipe(
            Effect.matchCauseEffect({
              onFailure: (unencoded) =>
                concealed(Cause.combine(cause, unencoded)),
              onSuccess: (encoded) => Effect.fail(new DeclaredFailure(encoded)),
            })
          )
        : Effect.failCause(failure.failure);
    });
};

type Boundary = ReturnType<typeof callBoundaryOf>;

const servedCall =
  <A, R>(
    steps: readonly Step[],
    boundary: Boundary,
    call: (
      payload: Schema.Json,
      options: Omit<CallOptions, "payload">
    ) => Effect.Effect<A, unknown, R>
  ) =>
  (payload: Schema.Json, options: Omit<CallOptions, "payload">) =>
    boundary(
      throughSteps(steps, call(payload, options), { ...options, payload })
    );

const handlerOf = (
  action: Action.Any,
  run: ErasedHandler<unknown>,
  steps: readonly Step[],
  error: Schema.Union<Action.Errors>
) => {
  const decode = decodeInput(action);

  const encode = Schema.encodeUnknownEffect(Schema.toCodecJson(action.success));

  return servedCall(steps, callBoundaryOf(error), (payload) =>
    Effect.suspend(() => decode(payload)).pipe(
      Effect.flatMap(run),
      Effect.flatMap(encode)
    )
  );
};

interface Sent extends Schema.JsonObject {
  readonly _tag: Progressed["_tag"];
  readonly value: Schema.Json;
}

type Sending = (
  input: ErasedValue,
  reporting: Reporting,
  send: (sent: Sent) => Effect.Effect<void>
) => Effect.Effect<void, unknown, unknown>;

const streamingHandlerOf = (
  action: Action.Any,
  sending: Sending,
  steps: readonly Step[],
  error: Schema.Union<Action.Errors>
) => {
  const decode = decodeInput(action);
  const boundary = callBoundaryOf(error);

  const encodeProgress = Schema.encodeUnknownEffect(
    Schema.toCodecJson(action.progress ?? Schema.Never)
  );

  return servedCall(steps, boundary, (payload) =>
    Effect.gen(function* () {
      const input = yield* decode(payload);

      const sent = yield* Queue.bounded<
        Schema.Json,
        DeclaredFailure | Cause.Done
      >(1);

      const send = (each: Sent) => Effect.asVoid(Queue.offer(sent, each));

      yield* sending(
        input,
        {
          progress: (value) =>
            Effect.flatMap(Effect.orDie(encodeProgress(value)), (json) =>
              send({ _tag: "Progress", value: json })
            ),
        },
        send
      ).pipe(
        boundary,
        Queue.into(sent),
        Effect.forkScoped({ startImmediately: true })
      );

      return sent;
    })
  );
};

const sendingAnswer = (
  success: Codec,
  run: ErasedHandler<unknown>
): Sending => {
  const encode = Schema.encodeUnknownEffect(Schema.toCodecJson(success));

  return (input, reporting, send) =>
    run(input, reporting).pipe(
      Effect.flatMap(encode),
      Effect.flatMap((value) => send({ _tag: "Final", value }))
    );
};

const sendingElements = (
  element: Codec,
  run: ErasedHandler<unknown>
): Sending => {
  const encode = Schema.encodeUnknownEffect(Schema.toCodecJson(element));

  return (input, reporting, send) =>
    Stream.runForEach(elementsOf(run(input, reporting)), (each) =>
      Effect.flatMap(encode(each), (value) => send({ _tag: "Element", value }))
    );
};

/**
 * One event subscription a `SubscriptionKeeper` keeps, as it arrived: the request a keeper writes
 * to the server again, once restarted, with the payload `resumeFrom` gave for the last value sent.
 */
export interface KeptSubscription {
  readonly clientId: number;
  readonly requestId: string | number;
  readonly tag: string;
  /** The subscription's payload, an object of its `input` and the `cursor` it resumes from. */
  readonly payload: Schema.Json;
  /** The headers the request was authenticated with, which a resumed one is authenticated with again. */
  readonly headers: ReadonlyArray<readonly [string, string]>;
  /**
   * The payload that resumes the subscription after `values`, a chunk sent for it, or
   * `undefined` where they reach no position. It never throws, being called as the protocol
   * sends: an input that does not encode fails its subscription as it is admitted instead.
   */
  readonly resumeFrom: (
    values: RpcMessage.ResponseChunkEncoded["values"]
  ) => Schema.Json | undefined;
}

/**
 * What a protocol keeping event subscriptions across restarts of its server offers under
 * `subscriptionKeeper`, as the Cloudflare package's `layerWebSocket` does: `layer` hands it each
 * subscription once admitted, and sends every position the subscription reaches, with no
 * 30-second heartbeat, whose timer would keep such a host awake.
 */
export interface SubscriptionKeeper {
  readonly keep: (subscription: KeptSubscription) => Effect.Effect<void>;
}

const subscriptionHandlerOf = (
  feed: Feed,
  steps: readonly Step[],
  error: Schema.Union<Action.Errors>,
  keeper: SubscriptionKeeper | undefined
) => {
  const decode = decodeInput({ input: SubscriptionOf(feed.event) });
  const encodeInput = Schema.encodeEffect(Schema.toCodecJson(feed.event.input));

  const sent = Schema.toCodecJson(PushedOf(feed.event));
  const encode = Schema.encodeEffect(sent);
  const decodeSent = Schema.decodeUnknownOption(sent);
  const boundary = callBoundaryOf(error);

  return servedCall(steps, boundary, (payload, options) =>
    Effect.gen(function* () {
      const { input, cursor } = yield* decode(payload);
      const open = yield* feed.stream(input);

      if (keeper !== undefined) {
        const resumed = yield* Effect.orDie(encodeInput(input));

        yield* keeper.keep({
          clientId: options.client.id,
          requestId: options.requestId,
          tag: feed.event.name,
          payload,
          headers: Object.entries(options.headers),
          resumeFrom: (values) => {
            const reached = values
              .flatMap((value) => Option.toArray(decodeSent(value)))
              .map((pushed) =>
                Match.value(pushed).pipe(
                  Match.tag("Failed", () => null),
                  Match.orElse((positioned) => positioned.cursor)
                )
              )
              .findLast(Predicate.isNotNull);

            return reached === undefined
              ? undefined
              : { input: resumed, cursor: reached };
          },
        });
      }

      return yield* queuedPush(open, cursor, encode, {
        ending: boundary,
        positions: keeper === undefined ? "heartbeat" : "watermark",
      });
    })
  );
};

export const verifyingNative = (
  verify: Verification,
  { headers }: CallOptions
) =>
  withSyntheticRequestFromHeaders(headers)(verify).pipe(
    Effect.catchCauseIf(Cause.hasDies, concealed)
  );

const requested: Step = (effect, { headers }) =>
  withSyntheticRequestFromHeaders(headers)(effect);

interface HandlersOptions {
  readonly apps: readonly AnyImplementation[];
  readonly events: readonly AnyEventImplementation[];
  readonly authentication: Authentication | undefined;
  readonly middleware: readonly RpcMiddleware.AnyService[];
  readonly keeper: SubscriptionKeeper | undefined;
}

export const handlersOf = Effect.fnUntraced(function* (
  binding: Declaring,
  { apps, events, authentication, middleware, keeper }: HandlersOptions
) {
  const listedMiddleware: readonly Step[] = yield* Effect.forEach(
    middleware,
    (key) => Effect.service(key)
  );

  const authenticating =
    authentication === undefined
      ? undefined
      : yield* authenticatingOf(authentication);

  const bound = yield* acquire(apps, authentication);
  const feeds = yield* acquireFeeds(events);

  const stepsOf = (caller: Action.Any["caller"]): readonly Step[] =>
    caller === Anyone || authenticating === undefined
      ? [...listedMiddleware, requested]
      : [...listedMiddleware, authenticating((verify) => verify), requested];

  const handlerFor = (
    action: Action.Any,
    run: ErasedHandler<unknown>,
    steps: readonly Step[],
    error: Schema.Union<Action.Errors>
  ) => {
    const streaming = (sending: Sending) =>
      streamingHandlerOf(action, sending, steps, error);

    return Answering.$match(answeringOf(action), {
      Value: () => handlerOf(action, run, steps, error),
      Progressed: ({ success }) => streaming(sendingAnswer(success, run)),
      Elements: ({ element }) => streaming(sendingElements(element, run)),
    });
  };

  const handlers = {
    ...Object.fromEntries(
      bound.map(
        ([action, run]) =>
          [
            action.name,
            handlerFor(
              action,
              run,
              stepsOf(action.caller),
              Schema.Union(bindingErrors(action, binding))
            ),
          ] as const
      )
    ),
    ...Object.fromEntries(
      feeds.map(
        (feed) =>
          [
            feed.event.name,
            subscriptionHandlerOf(
              feed,
              stepsOf(feed.event.caller),
              Schema.Union(eventErrors(feed.event, binding)),
              keeper
            ),
          ] as const
      )
    ),
  };

  return { handlers, authenticating };
});
