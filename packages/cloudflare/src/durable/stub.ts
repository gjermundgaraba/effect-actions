import {
  Context,
  Effect,
  Function,
  Layer,
  Option,
  Predicate,
  Schema,
} from "effect";
import type { Scope } from "effect";
import { RpcClient, RpcClientError, RpcSchema } from "effect/rpc";
import type { RpcMessage, Rpc, RpcGroup } from "effect/rpc";

import { codecFor } from "./calls.js";
import type { StubRequest } from "./calls.js";
import { RequestId } from "./frames.js";

/**
 * What a call reaches an object's rpcs through: a `DurableObjectStub` of a class `make` returns,
 * or of a class delegating `effectActionsRpc` to `handlers`, as `getByName` returns it. Its
 * answer is untyped data until the client checks it: Workers RPC's types rewrite a returned
 * tuple as an array.
 */
export interface Stub {
  readonly effectActionsRpc: (
    request: StubRequest
  ) => Promise<readonly unknown[]>;
}

const clientError = (reason: RpcClientError.RpcClientDefect) =>
  new RpcClientError.RpcClientError({ reason });

const isAnswer = Schema.is(
  Schema.Array(Schema.Struct({ _tag: Schema.String }))
);

const completionOf = Schema.decodeUnknownOption(
  Schema.Union([
    Schema.TaggedStruct("Exit", { requestId: RequestId }),
    Schema.Struct({ _tag: Schema.Literals(["Defect", "ClientProtocolError"]) }),
  ])
);

const completesCall = (
  answer: ReadonlyArray<{ readonly _tag: string }>,
  request: RpcMessage.RequestEncoded
) =>
  answer.some((response) =>
    Option.exists(
      completionOf(response),
      (completion) =>
        !Predicate.isTagged(completion, "Exit") ||
        completion.requestId === request.id
    )
  );

const makeProtocol = (target: Effect.Effect<Stub>) =>
  RpcClient.Protocol.make((write) =>
    Effect.succeed({
      send: (clientId: number, request: RpcMessage.FromClientEncoded) =>
        Predicate.isTagged(request, "Request")
          ? Effect.gen(function* () {
              const stub = yield* target;

              const answer = yield* Effect.tryPromise({
                try: async () => await stub.effectActionsRpc([request]),
                catch: (cause) =>
                  clientError(
                    new RpcClientError.RpcClientDefect({
                      message: "The object's stub refused the call",
                      cause,
                    })
                  ),
              });

              if (!(isAnswer(answer) && completesCall(answer, request))) {
                return yield* clientError(
                  new RpcClientError.RpcClientDefect({
                    message:
                      "The object's answer ended before the call completed: delegate effectActionsRpc to handlers' own, returning its answer",
                    cause: request,
                  })
                );
              }

              yield* Effect.forEach(
                // oxlint-disable-next-line typescript/no-unsafe-type-assertion
                answer as readonly RpcMessage.FromServerEncoded[],
                (response) => write(clientId, response),
                { discard: true }
              );
            })
          : Effect.void,
      supportsAck: false,
      supportsTransferables: false,
      codecFor,
    })
  );

/**
 * The `RpcClient.Protocol` `RpcClient.make` and `ActionRpc.client` call an object's rpcs with,
 * over the stub `stubOf` returns as each call is sent: each call is one call
 * of the object's `effectActionsRpc` method, its messages and their answer passed as values,
 * each schema's plain form, which the object serves through `make`'s or `handlers`' `calls`. The stub's own failure is an `RpcClientError`, as an HTTP transport's
 * is, in every call's errors.
 *
 * **Gotchas**
 *
 * - `stubOf` is called as each call is sent, `() => env.ROOM.getByName(name)`, for a new stub each time, since many exceptions leave a stub broken, failing every later call through it with the same error; one that throws is a defect, not an `RpcClientError`, as it is no failure of the stub.
 * - An `RpcClientError`'s `RpcClientDefect` holds the runtime's error as its `cause`: `.retryable` true allows repeating the call, as Cloudflare's guide says, and `.durableObjectReset` true needs a new stub, which the next call's `stubOf` gives.
 * - Workers RPC limits a call's arguments and its answer to 32 MiB, serialized: past it, the call fails with the runtime's `limited to 32MiB` error.
 * - An object serving no `calls`, once built, or a class without the method, fails each call, with the object's or the runtime's message as the error's cause; an object whose build fails fails it with that failure first.
 * - A call's interruption does not reach the object, as a stub call cannot be cancelled: its answer is dropped.
 * - Unary: an rpc that streams fails with a defect at its first chunk, so a handler returning a stream that never emits leaves the call waiting for good; `client` gives such an rpc no method.
 * - `RpcClient.make` over it forks a fiber started on a timer of the request that builds it, which workerd drops when that request ends: a client first built lazily inside a Worker's request that ends without waiting on I/O never starts it, and every later call waits until workerd cancels it as hung; build the client per request or, shared, at module scope under Effect's sync scheduler, as `HttpRouter.toWebHandler`'s gotchas show, where a `ManagedRuntime.make` builds only at its first run, so one made at module scope is still built inside a request; an object's build, under the microtask scheduler, did not strand it in the tests.
 *
 * Guide: `docs/ActionDurableObject-stub.md` in this package.
 */
export const layerStubClient = (
  stubOf: () => Stub
): Layer.Layer<RpcClient.Protocol> =>
  Layer.effect(RpcClient.Protocol)(makeProtocol(Effect.sync(stubOf)));

const StubOfCurrentCall = Context.Reference<(() => Stub) | undefined>(
  "effect-actions-cloudflare/ActionDurableObject/CurrentStub",
  { defaultValue: Function.constUndefined }
);

const currentStub = Effect.flatMap(
  Effect.service(StubOfCurrentCall),
  (stubOf) =>
    stubOf === undefined
      ? Effect.die(new Error("No stub for the call"))
      : Effect.sync(stubOf)
);

type Unary<Rpcs extends Rpc.Any> = Rpcs extends Rpc.Any
  ? [Rpc.SuccessSchema<Rpcs>] extends [RpcSchema.Stream<infer _A, infer _E>]
    ? never
    : Rpcs
  : never;

type NativeMethod = (
  payload: never,
  options?: never
) => Effect.Effect<unknown, unknown>;

interface NativeClient {
  readonly [tag: string]: NativeMethod;
}

/**
 * A group's rpcs, as `client.<rpc>(payload)`: Effect's native client, each call failing with
 * the rpc's declared errors or an `RpcClientError`. An rpc that streams has no method: the
 * transport is unary.
 */
export type Client<Group> = RpcClient.RpcClient<
  Unary<RpcGroup.Rpcs<Group>>,
  RpcClientError.RpcClientError
>;

/**
 * The rpcs of `group`, as `(stubOf) => client`, for a Worker or an object calling objects of
 * one class: `room(() => env.CHAT_ROOM.getByName(name)).latestAt()`. One native client, built
 * in the given `Scope`, serves every object, and each call gets its stub from `stubOf` as it is
 * sent, so no stub is held, nothing is kept per object and an eviction changes nothing: a
 * client over one object may be kept for good. Each call goes over `layerStubClient`'s
 * transport, whose gotchas hold here too: a call fails with the rpc's declared errors and the
 * stub's own failure, an `RpcClientError`, as Effect's native client does.
 *
 * **Gotchas**
 *
 * - `stubOf` reads `env` as each call is sent, from the `env` import of `cloudflare:workers` or the `env` `make`'s `services` function is given, never as the module evaluates; one that throws is a defect.
 * - Only names you accept should reach `getByName`: each name is another object.
 * - An `ActionRpc` binding's `group` fails here, `Expected null`, as `ActionRpc.layer` carries its values as JSON over the stub's protocol passing values: call such an object's actions and native rpcs with `ActionRpc.client` over `layerStubClient(() => stub)`.
 * - An rpc that streams has no method, as `Client` types it.
 *
 * Guide: `docs/ActionDurableObject-stub.md` in this package.
 */
export const client = <Rpcs extends Rpc.Any>(
  group: RpcGroup.RpcGroup<Rpcs>
): Effect.Effect<
  (stubOf: () => Stub) => Client<RpcGroup.RpcGroup<Rpcs>>,
  never,
  Scope.Scope | Rpc.MiddlewareClient<Rpcs>
> =>
  Effect.gen(function* () {
    const native: NativeClient = yield* RpcClient.make(group).pipe(
      Effect.provideServiceEffect(
        RpcClient.Protocol,
        makeProtocol(currentStub)
      ),
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      Effect.map((made) => made as NativeClient)
    );

    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    const rpcs = group.requests.values() as Iterable<Rpc.AnyWithProps>;

    const unary = new Set(
      [...rpcs].flatMap((rpc) =>
        RpcSchema.isStreamSchema(rpc.successSchema) ? [] : [rpc._tag]
      )
    );

    return (stubOf: () => Stub) =>
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      Object.fromEntries(
        Object.entries(native).flatMap(([tag, method]) =>
          unary.has(tag)
            ? [
                [
                  tag,
                  (...args: Parameters<NativeMethod>) =>
                    method(...args).pipe(
                      Effect.provideService(StubOfCurrentCall, stubOf)
                    ),
                ],
              ]
            : []
        )
      ) as Client<RpcGroup.RpcGroup<Rpcs>>;
  });
