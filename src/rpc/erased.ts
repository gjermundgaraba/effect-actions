import {
  Cause,
  Effect,
  ErrorReporter,
  Option,
  Predicate,
  Queue,
  Result,
  Schema,
  SchemaTransformation,
  Stream,
} from "effect";
import type { Duration } from "effect";
import { HttpClientRequest, HttpServerRequest } from "effect/http";
import type { Headers } from "effect/http";
import { HttpApiBuilder } from "effect/http-api";
import { Rpc, RpcGroup } from "effect/rpc";
import type { RpcMiddleware } from "effect/rpc";

import { providerOf } from "../authentication/provider.js";
import type { Any as Authentication } from "../authentication/provider.js";
import type * as Action from "../contract/Action.js";
import {
  checked,
  checkedStream,
  decodeInput,
  sendingJson,
  sentInput,
} from "../contract/call.js";
import type { CheckedMethod } from "../contract/call.js";
import { Anyone, principalOf } from "../contract/caller.js";
import type { Codec } from "../contract/codec.js";
import { bindingErrors, eventErrors } from "../contract/declared.js";
import type { Declaring } from "../contract/declared.js";
import { Unavailable } from "../contract/errors.js";
import * as Event from "../contract/Event.js";
import { acquireFeeds } from "../contract/feed.js";
import type { AnyEventImplementation, Feed } from "../contract/feed.js";
import { acquire, answered, elementsOf } from "../contract/implementation.js";
import type {
  AnyImplementation,
  ErasedHandler,
  ErasedValue,
} from "../contract/implementation.js";
import { pageOf, rpcPageOf } from "../contract/pages.js";
import { answerFrom, elementsFrom } from "../contract/progress.js";
import type { Reporting, Progressed } from "../contract/progress.js";
import { PushedOf, queuedPush, SubscriptionOf } from "../contract/push.js";
import { concealed, reported } from "../contract/reported.js";
import { answeringOf, Answering, elementOf } from "../contract/stream.js";
import {
  deliveryUnsupported,
  Subscribed,
  WebhookCancellationOf,
  WebhookSubscriptionOf,
} from "../contract/subscribe.js";
import { watching } from "../contract/watch.js";
import type { Transport } from "../contract/watch.js";
import {
  offersWebhook,
  servingFeeds,
  webhookAnswers,
} from "../contract/webhooks.js";
import type { WebhookHolder } from "../contract/webhooks.js";
import { isUnknownTag, polledTransportOf, streamingOf } from "./watch.js";

const streams = (action: Action.Any) =>
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
    ) =>
      <A, E, R>(effect: Effect.Effect<A, E, R>, options: CallOptions) =>
        Effect.provideServiceEffect(
          effect,
          authentication.identity,
          verifying(verify, options)
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

const unaryOf = (name: string) =>
  Rpc.make(name, {
    payload: Schema.Json,
    success: Schema.Json,
    error: Declared,
  });

export type Server =
  | {
      readonly _tag: "ActionRpc.layer";
      readonly middleware: readonly RpcMiddleware.AnyService[];
    }
  | { readonly _tag: "ActionEntity.layer"; readonly check: InputCheck };

const streamsEvents = (server: Server["_tag"]) => server === "ActionRpc.layer";

/**
 * The tag of the unary rpc polling the event type `name`, `<name>/poll`, taking `Poll` beside
 * its `input` and answering a `Page`, which `ActionRpc.layer` and an `ActionEntity` serve and
 * `ActionRpc.client`'s polling watch calls.
 */
export const pollTag = (name: string) => `${name}/poll`;

const subscribeTag = (name: string) => `${name}/subscribe`;

const unsubscribeTag = (name: string) => `${name}/unsubscribe`;

export const webhookRpcsOf = (events: readonly Event.Any[]) =>
  RpcGroup.make(
    ...events
      .filter(offersWebhook)
      .flatMap((event) => [
        unaryOf(subscribeTag(event.name)),
        unaryOf(unsubscribeTag(event.name)),
      ])
  );

const webhookErrors = (event: Event.Any, binding: Declaring) =>
  Schema.Union([...eventErrors(event, binding), Event.SubscriptionError]);

export const erasedOf = (
  actions: readonly Action.Any[],
  events: readonly Event.Any[],
  server: Server["_tag"]
) =>
  RpcGroup.make(
    ...actions.map((action) =>
      streams(action) ? streamOf(action.name) : unaryOf(action.name)
    ),
    ...events.flatMap((event) => [
      ...(streamsEvents(server) ? [streamOf(event.name)] : []),
      unaryOf(pollTag(event.name)),
    ])
  );

const Watch = Schema.String.check(Schema.isUUID());

/**
 * The payload of an event type's poll rpc, `<event>/poll`, past its `input`, as a client sends
 * it: the `cursor` to read after, `null` reading from now, at most `maxEvents` occurrences, and
 * the `watch`, a UUID one watch sends with each of its polls, which tells a page's watches apart
 * on a socket and holds nothing on the server: a poll's subscription hook is its caller's.
 */
export const Poll = Schema.Struct({
  cursor: Schema.NullOr(Schema.String),
  maxEvents: Schema.optionalKey(Schema.Finite),
  watch: Schema.optionalKey(Watch),
});

const PollOf = (event: Event.Any) =>
  Schema.Struct({ ...Poll.fields, ...SubscriptionOf(event).fields });

export interface ErasedCall {
  readonly unary: (
    tag: string,
    payload: Schema.Json
  ) => Effect.Effect<Schema.Json, unknown>;
  readonly stream: (
    tag: string,
    payload: Schema.Json
  ) => Stream.Stream<Schema.Json, unknown>;
}

export const erasedCallOf = (
  send: (
    tag: string,
    payload: Schema.Json
  ) => Effect.Effect<Schema.Json, unknown> | Stream.Stream<Schema.Json, unknown>
): ErasedCall => ({
  unary: (tag, payload) => {
    const answer = send(tag, payload);

    return Effect.isEffect(answer)
      ? answer
      : Effect.die(new Error(`The rpc ${tag} streams, called as unary`));
  },
  stream: (tag, payload) => {
    const answer = send(tag, payload);

    return Stream.isStream(answer)
      ? answer
      : Stream.die(new Error(`The rpc ${tag} is unary, called as a stream`));
  },
});

export const ProgressedOf = <P extends Codec, S extends Codec>(
  progress: P,
  success: S
) =>
  Schema.Union([
    Schema.TaggedStruct("Progress", { value: progress }),
    Schema.TaggedStruct("Final", { value: success }),
  ]);

const elementedOf = (element: Codec, progress: Codec | undefined) =>
  Schema.Union([
    Schema.TaggedStruct("Element", { value: element }),
    ...(progress === undefined
      ? []
      : [Schema.TaggedStruct("Progress", { value: progress })]),
  ]);

export const streamedOf = (
  action: Action.Any
): Schema.Codec<Progressed> | undefined =>
  Answering.$match(answeringOf(action), {
    Value: () => undefined,
    Progressed: ({ success, progress }) => ProgressedOf(progress, success),
    Elements: ({ element, progress }) => elementedOf(element, progress),
  });

export const nativeOf = (group: RpcGroup.Any) =>
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  group as RpcGroup.RpcGroup<Rpc.AnyWithProps>;

const isDeclared = (failure: unknown): failure is DeclaredFailure =>
  failure instanceof DeclaredFailure;

const failedOf = (error: Schema.Union<Action.Errors>) => {
  const decode = Schema.decodeUnknownEffect(Schema.toCodecJson(error));

  return (failure: DeclaredFailure) =>
    Effect.flatMap(Effect.orDie(decode(failure.json)), Effect.fail);
};

const calledMethodOf = (
  action: Action.Any,
  binding: Declaring
): ((call: ErasedCall) => CheckedMethod) => {
  const failed = failedOf(Schema.Union(bindingErrors(action, binding)));
  const streamed = streamedOf(action);
  const encode = sendingJson(action);
  const sending = () => encode;

  if (streamed === undefined) {
    const decode = Schema.decodeUnknownEffect(
      Schema.toCodecJson(action.success)
    );

    return (call) =>
      checked(action, sending, (json) =>
        call.unary(action.name, json).pipe(
          Effect.catchIf(isDeclared, failed),
          Effect.flatMap((sent) => Effect.orDie(decode(sent)))
        )
      );
  }

  const decode = Schema.decodeUnknownEffect(Schema.toCodecJson(streamed));

  const progressed = (call: ErasedCall, json: Schema.Json) =>
    call.stream(action.name, json).pipe(
      Stream.catchIf(isDeclared, (failure) =>
        Stream.fromEffect(failed(failure))
      ),
      Stream.mapEffect((sent) => Effect.orDie(decode(sent)))
    );

  return elementOf(action.success) === undefined
    ? (call) =>
        checked(action, sending, (json, onProgress) =>
          answerFrom(progressed(call, json), onProgress)
        )
    : (call) =>
        checkedStream(action, sending, (json, onProgress) =>
          elementsFrom(progressed(call, json), onProgress)
        );
};

type EventTransport = (
  event: Event.Any,
  binding: Declaring
) => (
  call: ErasedCall
) => (input: Schema.Json, streamOnly: boolean) => Transport<unknown, never>;

export const streamedTransport =
  (silenceEnds: boolean, polled: EventTransport): EventTransport =>
  (event, binding) => {
    const decode = Schema.decodeUnknownEffect(
      Schema.toCodecJson(PushedOf(event))
    );

    const failed = failedOf(Schema.Union(eventErrors(event, binding)));

    const polledThrough = polled(event, binding);

    return (call) => {
      const polling = polledThrough(call);

      return (input, streamOnly) => ({
        ...polling(input, streamOnly),
        stream: streamingOf(
          event,
          (cursor) =>
            call.stream(event.name, { input, cursor }).pipe(
              Stream.catchIf(isDeclared, (failure) =>
                Stream.fromEffect(failed(failure))
              ),
              Stream.mapEffect((json) => Effect.orDie(decode(json)))
            ),
          silenceEnds,
          streamOnly
        ),
      });
    };
  };

export const pollOf = (event: Event.Any, binding: Declaring) => {
  const decode = Schema.decodeUnknownEffect(Schema.toCodecJson(pageOf(event)));

  const failed = failedOf(Schema.Union(eventErrors(event, binding)));

  return (call: ErasedCall) =>
    (payload: {
      readonly input: Schema.Json;
      readonly cursor: string | null;
      readonly maxEvents?: number;
      readonly watch?: string;
    }) =>
      call.unary(pollTag(event.name), payload).pipe(
        Effect.catchIf(isDeclared, failed),
        Effect.flatMap((json) => Effect.orDie(decode(json)))
      );
};

export const watchedOf = (event: Event.Any, binding: Declaring) => {
  const pollThrough = pollOf(event, binding);

  return (call: ErasedCall) => {
    const poll = pollThrough(call);

    return (input: Schema.Json): Pick<Transport<unknown, never>, "poll"> => ({
      poll: (cursor, watch) =>
        poll({ input, cursor, ...(watch === undefined ? {} : { watch }) }),
    });
  };
};

export const webhookCallsOf = (
  event: Event.Any,
  binding: Declaring
): ((call: ErasedCall) => WebhookHolder) => {
  const failed = failedOf(webhookErrors(event, binding));

  const encodeSubscription = Schema.encodeUnknownEffect(
    Schema.toCodecJson(WebhookSubscriptionOf(event))
  );

  const encodeCancellation = Schema.encodeUnknownEffect(
    Schema.toCodecJson(WebhookCancellationOf(event))
  );

  const decode = Schema.decodeUnknownEffect(Schema.toCodecJson(Subscribed));

  return (call) => ({
    subscribe: ({ input, delivery, cursor, ttlMs }) =>
      Effect.orDie(encodeSubscription({ input, delivery, cursor, ttlMs })).pipe(
        Effect.flatMap((json) => call.unary(subscribeTag(event.name), json)),
        Effect.catchIf(isDeclared, failed),
        Effect.flatMap((json) => Effect.orDie(decode(json)))
      ),
    unsubscribe: ({ input, delivery: { url } }) =>
      Effect.orDie(encodeCancellation({ input, delivery: { url } })).pipe(
        Effect.flatMap((json) => call.unary(unsubscribeTag(event.name), json)),
        Effect.catchIf(isDeclared, failed),
        Effect.asVoid
      ),
  });
};

const resending =
  (
    poll: Transport<unknown, never>["poll"],
    after: Duration.Input
  ): Transport<unknown, never>["poll"] =>
  (cursor, watch) =>
    Effect.timeoutOrElse(poll(cursor, watch), {
      duration: after,
      orElse: () => resending(poll, after)(cursor, watch),
    });

export const polledTransport =
  (
    transient: (error: unknown) => boolean,
    resendAfter?: Duration.Input
  ): EventTransport =>
  (event, binding) => {
    const watchedThrough = watchedOf(event, binding);
    const pollUnserved = isUnknownTag(pollTag(event.name));

    return (call) => {
      const watched = watchedThrough(call);

      return (input) => {
        const { poll } = watched(input);

        return polledTransportOf(
          event,
          {
            poll:
              resendAfter === undefined ? poll : resending(poll, resendAfter),
          },
          transient,
          pollUnserved
        );
      };
    };
  };

interface ClientBinding extends Declaring {
  readonly actions: readonly Action.Any[];
  readonly events: readonly Event.Any[];
}

export type Reach = (
  contract: Action.Any | Event.Any,
  input: ErasedValue
) => Effect.Effect<ErasedCall, Action.Forbidden>;

export const actionMethodOf = (
  action: Action.Any,
  binding: Declaring
): ((reach: Reach) => CheckedMethod<unknown>) => {
  const method = calledMethodOf(action, binding);

  const answer = (reach: Reach, [input, ...rest]: readonly ErasedValue[]) =>
    Effect.flatMap(sentInput(action, input), ({ value }) =>
      Effect.map(reach(action, value), (call) => method(call)(value, ...rest))
    );

  return elementOf(action.success) === undefined
    ? (reach) =>
        (...args) =>
          Effect.flatMap(answer(reach, args), answered)
    : (reach) =>
        (...args) =>
          elementsOf(answer(reach, args));
};

export const methodsOf = (
  binding: ClientBinding,
  transport: EventTransport,
  watchMode?: "stream" | "poll"
) => {
  const actions = binding.actions.map(
    (action) => [action.name, actionMethodOf(action, binding)] as const
  );

  const transports = new Map(
    binding.events.map(
      (event) => [event.name, transport(event, binding)] as const
    )
  );

  return (reach: Reach) => {
    const methods = Object.fromEntries<unknown>(
      actions.map(([name, method]) => [name, method(reach)] as const)
    );

    if (transports.size === 0) {
      return methods;
    }

    const watch = (
      event: Event.Any,
      input?: ErasedValue,
      watchOptions?: Event.WatchOptions<unknown>
    ): Stream.Stream<Event.Received<Event.Any>, unknown> => {
      const feed = transports.get(event.name);

      if (feed === undefined) {
        return Stream.die(
          new Error(
            `ActionRpc.client: the binding holds no event type ${event.name} (watch one the binding ActionRpc.make returned lists)`
          )
        );
      }

      const mode = watchOptions?.mode ?? watchMode;

      return Stream.unwrap(
        Effect.flatMap(sentInput(event, input), ({ json, value }) =>
          Effect.map(reach(event, value), (call) =>
            watching(feed(call)(json, mode === "stream"), {
              ...watchOptions,
              mode,
            })
          )
        )
      );
    };

    return { ...methods, watch };
  };
};

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

const subscriptionHandlerOf = (
  feed: Feed,
  steps: readonly Step[],
  error: Schema.Union<Action.Errors>
) => {
  const decode = decodeInput({ input: SubscriptionOf(feed.event) });
  const encode = Schema.encodeEffect(Schema.toCodecJson(PushedOf(feed.event)));
  const boundary = callBoundaryOf(error);

  return servedCall(steps, boundary, (payload) =>
    Effect.gen(function* () {
      const { input, cursor } = yield* decode(payload);
      const open = yield* feed.stream(input);

      return yield* queuedPush(open, cursor, encode, {
        ending: boundary,
        positions: "heartbeat",
      });
    })
  );
};

const pollHandlerOf = (
  feed: Feed,
  steps: readonly Step[],
  error: Schema.Union<Action.Errors>,
  authentication: Authentication | undefined,
  check: Checking
) => {
  const decode = decodeInput({ input: PollOf(feed.event) });
  const encode = Schema.encodeEffect(Schema.toCodecJson(rpcPageOf(feed.event)));

  return servedCall(steps, callBoundaryOf(error), (payload) =>
    Effect.gen(function* () {
      const { input, cursor, maxEvents } = yield* decode(payload);

      yield* check(input);

      const subscriber = yield* principalOf(feed.event, authentication);

      const page = yield* feed
        .poll(input, cursor, { subscriber, maxEvents })
        .pipe(
          Effect.catchCauseIf(Cause.hasDies, (cause) =>
            Effect.andThen(
              reported(cause),
              Effect.fail(
                new Unavailable({
                  message: `Event "${feed.event.name}" could not be read: try again later.`,
                })
              )
            )
          )
        );

      return yield* encode({ ...page, notified: !feed.polls });
    })
  );
};

const pollingRefused = ({ event }: Feed) =>
  Effect.logWarning(
    `An entity refused a webhook subscription to "${event.name}", whose check source is not notified: its timer would be cut by Effect's entity reaper and keep a Durable Object awake (mark the source notified, notifying after each write, or serve the event's webhooks from a surface outside the entity)`
  );

const webhookHandlersOf = (
  feed: Feed,
  steps: readonly Step[],
  error: Schema.Union<Action.Errors>,
  answers: ReturnType<typeof webhookAnswers>,
  check: Checking
) => {
  const subscribing = decodeInput({ input: WebhookSubscriptionOf(feed.event) });
  const cancelling = decodeInput({ input: WebhookCancellationOf(feed.event) });
  const encode = Schema.encodeEffect(Schema.toCodecJson(Subscribed));
  const boundary = callBoundaryOf(error);

  return [
    [
      subscribeTag(feed.event.name),
      servedCall(steps, boundary, (payload) =>
        Effect.suspend(() => subscribing(payload)).pipe(
          Effect.tap(({ input }) => check(input)),
          Effect.flatMap(answers.subscribe),
          Effect.flatMap(encode)
        )
      ),
    ],
    [
      unsubscribeTag(feed.event.name),
      servedCall(steps, boundary, (payload) =>
        Effect.suspend(() => cancelling(payload)).pipe(
          Effect.tap(({ input }) => check(input)),
          Effect.flatMap(answers.unsubscribe),
          Effect.as(null)
        )
      ),
    ],
  ] as const;
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

export type InputCheck = (
  contract: Action.Any | Event.Any,
  input: ErasedValue
) => Effect.Effect<void, Action.Forbidden>;

type Checking = (input: ErasedValue) => Effect.Effect<void, Action.Forbidden>;

interface HandlersOptions {
  readonly apps: readonly AnyImplementation[];
  readonly events: readonly AnyEventImplementation[];
  readonly authentication: Authentication | undefined;
  readonly server: Server;
}

export const handlersOf = Effect.fnUntraced(function* (
  binding: Declaring,
  { apps, events, authentication, server }: HandlersOptions
) {
  const holdsWebhooks = server._tag === "ActionEntity.layer";

  const check: InputCheck =
    server._tag === "ActionEntity.layer" ? server.check : () => Effect.void;

  const listedMiddleware: readonly Step[] =
    server._tag === "ActionRpc.layer"
      ? yield* Effect.forEach(server.middleware, (key) => Effect.service(key))
      : [];

  const authenticating =
    authentication === undefined
      ? undefined
      : yield* authenticatingOf(authentication);

  const bound = yield* acquire(apps, authentication);

  const { feeds, webhooks } = holdsWebhooks
    ? yield* servingFeeds(events, authentication, ({ polls }) => !polls)
    : { feeds: yield* acquireFeeds(events), webhooks: Option.none() };

  const heldAnswers = (feed: Feed) => {
    const answers = webhookAnswers(feed, authentication, webhooks);

    if (!feed.polls || Option.isNone(webhooks)) {
      return answers;
    }

    return {
      ...answers,
      subscribe: () =>
        Effect.andThen(
          pollingRefused(feed),
          Effect.fail(deliveryUnsupported(feed.event.name, "webhook"))
        ),
    };
  };

  const stepsOf = (caller: Action.Any["caller"]): readonly Step[] =>
    caller === Anyone || authenticating === undefined
      ? [...listedMiddleware, requested]
      : [...listedMiddleware, authenticating((verify) => verify), requested];

  const handlerFor = (
    action: Action.Any,
    unchecked: ErasedHandler<unknown>,
    steps: readonly Step[],
    error: Schema.Union<Action.Errors>
  ) => {
    const run: ErasedHandler<unknown> = (input, reporting) =>
      Effect.andThen(check(action, input), () => unchecked(input, reporting));

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
      streamsEvents(server._tag)
        ? feeds.map(
            (feed) =>
              [
                feed.event.name,
                subscriptionHandlerOf(
                  feed,
                  stepsOf(feed.event.caller),
                  Schema.Union(eventErrors(feed.event, binding))
                ),
              ] as const
          )
        : []
    ),
    ...Object.fromEntries(
      feeds.flatMap((feed) => {
        const steps = stepsOf(feed.event.caller);
        const error = Schema.Union(eventErrors(feed.event, binding));
        const checking: Checking = (input) => check(feed.event, input);

        return [
          [
            pollTag(feed.event.name),
            pollHandlerOf(feed, steps, error, authentication, checking),
          ],
        ] as const;
      })
    ),
    ...Object.fromEntries(
      holdsWebhooks
        ? feeds
            .filter(({ event }) => offersWebhook(event))
            .flatMap((feed) =>
              webhookHandlersOf(
                feed,
                stepsOf(feed.event.caller),
                webhookErrors(feed.event, binding),
                heldAnswers(feed),
                (input) => check(feed.event, input)
              )
            )
        : []
    ),
  };

  return { handlers, authenticating };
});
