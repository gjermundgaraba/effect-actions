import { Context, Effect, Layer, Predicate, type Scope } from "effect";
import {
  RpcClient,
  RpcClientError,
  RpcMessage,
  RpcSchema,
  type Rpc,
  type RpcGroup,
} from "effect/rpc";
import { codecFor, type StubRequest } from "./calls.js";

/**
 * What a call reaches an object's rpcs through: a `DurableObjectStub` of a class `make` returns,
 * or of a class delegating `effectActionsRpc` to `handlers`, as `getByName` returns it. Its
 * answer is untyped data until the client checks it: Workers RPC's types rewrite a returned
 * tuple as an array.
 */
export interface Stub {
  readonly effectActionsRpc: (request: StubRequest) => Promise<ReadonlyArray<unknown>>;
}

const clientError = (reason: RpcClientError.RpcClientDefect) =>
  new RpcClientError.RpcClientError({ reason });

const makeProtocol = (target: Effect.Effect<Stub>) =>
  RpcClient.Protocol.make((write) =>
    Effect.succeed({
      send: (clientId: number, request: RpcMessage.FromClientEncoded) =>
        // Why: a call over the stub is answered once, so an interruption or an acknowledgement
        // has nowhere to go: an interrupted call's answer is dropped, as over Effect's HTTP
        // protocol.
        !Predicate.isTagged(request, "Request")
          ? Effect.void
          : Effect.gen(function* () {
              const stub = yield* target;

              const answer = yield* Effect.tryPromise({
                try: () => stub.effectActionsRpc([request]),
                catch: (cause) =>
                  clientError(
                    new RpcClientError.RpcClientDefect({
                      message: "The object's stub refused the call",
                      cause,
                    }),
                  ),
              });

              if (!Array.isArray(answer) || !answer.some(RpcMessage.isTerminalResponse)) {
                return yield* clientError(
                  new RpcClientError.RpcClientDefect({
                    message:
                      "The object's answer ended before the call completed: delegate effectActionsRpc to handlers' own, returning its answer",
                    cause: request,
                  }),
                );
              }

              yield* Effect.forEach(
                answer as ReadonlyArray<RpcMessage.FromServerEncoded>,
                (response) => write(clientId, response),
                { discard: true },
              );
            }),
      supportsAck: false,
      supportsTransferables: false,
      codecFor,
    }),
  );

/**
 * The `RpcClient.Protocol` `RpcClient.make` and `ActionRpc.client` call an object's rpcs with,
 * over `stub`: each call is one call of the object's `effectActionsRpc` method, its messages
 * and their answer passed as values, each schema's plain form, which the object serves on
 * `layerStub`, through `make`'s or `handlers`' `calls`. The stub's own failure is an
 * `RpcClientError`, as an HTTP transport's is, in every call's errors.
 *
 * **Gotchas**
 *
 * - It holds `stub`, and many exceptions leave a stub broken, failing every later call through it with the same error: after a failure, provide the client a `layerStubClient` over a new stub.
 * - Workers RPC limits a call's arguments and its answer to 32 MiB, serialized: past it, the call fails with the runtime's `limited to 32MiB` error.
 * - An object serving no `calls`, or a class without the method, fails each call at once, with the object's or the runtime's message as the error's cause.
 * - A call's interruption does not reach the object, as a stub call cannot be cancelled: its answer is dropped.
 * - Unary: an rpc that streams fails with a defect at its first chunk.
 *
 * Guide: `docs/ActionDurableObject-stub.md` in this package.
 */
export const layerStubClient = (stub: Stub): Layer.Layer<RpcClient.Protocol> =>
  Layer.effect(RpcClient.Protocol)(makeProtocol(Effect.succeed(stub)));

const CurrentStub = Context.Reference<(() => Stub) | undefined>(
  "effect-actions-cloudflare/ActionDurableObject/CurrentStub",
  { defaultValue: () => undefined },
);

const currentStub = Effect.flatMap(Effect.service(CurrentStub), (stubOf) =>
  stubOf === undefined ? Effect.die(new Error("No stub for the call")) : Effect.sync(stubOf),
);

type Unary<Rpcs extends Rpc.Any> = Rpcs extends Rpc.Any
  ? [Rpc.SuccessSchema<Rpcs>] extends [RpcSchema.Stream<infer _A, infer _E>]
    ? never
    : Rpcs
  : never;

type NativeMethod = (payload: never, options?: never) => Effect.Effect<unknown, unknown>;

type NativeClient = { readonly [tag: string]: NativeMethod | undefined };

const methodOf = (native: NativeClient, tag: string): NativeMethod => {
  const found = native[tag];

  if (found === undefined) throw new Error(`No client method for ${tag}`);

  return found;
};

/**
 * A group's rpcs, as `client.<rpc>(payload)`: Effect's native client, each call failing with
 * the rpc's declared errors alone. An rpc that streams has no method: the transport is unary.
 */
export type Client<Group> = RpcClient.RpcClient<Unary<RpcGroup.Rpcs<Group>>>;

/**
 * The rpcs of `group`, as `(stubOf) => client`, for a Worker or an object calling objects of
 * one class: `room(() => env.CHAT_ROOM.getByName(name)).latestAt()`. One native client, built
 * in the given `Scope`, serves every object, and each call gets its stub from `stubOf` as it is
 * sent, so no stub is held, nothing is kept per object and an eviction changes nothing: a
 * client over one object may be kept for good. A call fails with the rpc's declared errors
 * alone; the stub's own failure, which its caller cannot recover from, is a defect.
 *
 * **Gotchas**
 *
 * - Never hold a stub: Cloudflare's error handling guide says "Many exceptions leave the DurableObjectStub in a "broken" state", failing every later request through it, so `stubOf` makes a new one for each call.
 * - `stubOf` reads `env` as each call is sent, from the `env` import of `cloudflare:workers` or the `env` `make`'s `services` function is given, never as the module evaluates; one that throws is a defect.
 * - Only names you accept should reach `getByName`: each name is another object.
 * - A group with an rpc that streams is refused as the client is made: the transport is unary.
 * - For Effect's own typing, with `RpcClientError` in every call's errors, call `RpcClient.make(group)` over `layerStubClient(stub)`.
 *
 * Guide: `docs/ActionDurableObject-stub.md` in this package.
 */
export const client = <Rpcs extends Rpc.Any>(
  group: RpcGroup.RpcGroup<Rpcs>,
): Effect.Effect<
  (stubOf: () => Stub) => Client<RpcGroup.RpcGroup<Rpcs>>,
  never,
  Scope.Scope | Rpc.MiddlewareClient<Rpcs>
> =>
  Effect.gen(function* () {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Native group boundary: every rpc of a group is a native `Rpc`, carrying its schemas.
    for (const rpc of group.requests.values() as Iterable<Rpc.AnyWithProps>) {
      if (RpcSchema.isStreamSchema(rpc.successSchema)) {
        return yield* Effect.die(
          new Error(
            `The rpc ${rpc._tag} streams, and ActionDurableObject.client is unary: call it over layerWebSocket`,
          ),
        );
      }
    }

    // Why: `RpcClient.make` runs each call's send in the calling fiber's context, so the call's
    // stub factory is a reference set around it, and one client serves every object. The factory
    // runs at each send: a stub an exception broke fails every later call through it.
    const native: NativeClient = yield* RpcClient.make(group).pipe(
      Effect.provideServiceEffect(RpcClient.Protocol, makeProtocol(currentStub)),
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Erased native client: one method per rpc of the group, by its tag, each taking its payload and options.
      Effect.map((made) => made as NativeClient),
    );

    const tags = [...group.requests.keys()];

    return (stubOf: () => Stub) =>
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Erased client: one method per rpc of the group, each the native client's, whose declared errors and successes `Client` types; only the transport's `RpcClientError` is moved to the defects.
      Object.fromEntries(
        tags.map((tag) => [
          tag,
          (...args: Parameters<NativeMethod>) =>
            methodOf(
              native,
              tag,
            )(...args).pipe(
              Effect.provideService(CurrentStub, stubOf),
              Effect.catchIf(
                (error): error is RpcClientError.RpcClientError =>
                  Predicate.isTagged(error, "RpcClientError"),
                Effect.die,
              ),
            ),
        ]),
      ) as Client<RpcGroup.RpcGroup<Rpcs>>;
  });
