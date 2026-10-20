import { Context, Effect, Layer, Predicate, type Scope } from "effect";
import {
  RpcClient,
  RpcClientError,
  RpcMessage,
  RpcSchema,
  RpcSerialization,
  type Rpc,
  type RpcGroup,
} from "effect/rpc";

/**
 * What a caller holds to call an object's rpcs: a `DurableObjectStub` of a class `make` returns,
 * or of a class delegating `effectActionsRpc` to `handlers`, as `getByName` returns it.
 */
export interface Stub {
  readonly effectActionsRpc: (request: string) => Promise<string>;
}

const json = RpcSerialization.json;

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
              const parser = json.makeUnsafe();

              const answer = yield* Effect.tryPromise({
                // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- The JSON parser encodes to a string.
                try: () => stub.effectActionsRpc(parser.encode(request) as string),
                catch: (cause) =>
                  clientError(
                    new RpcClientError.RpcClientDefect({
                      message: "The object's stub refused the call",
                      cause,
                    }),
                  ),
              });

              const responses = yield* Effect.try({
                // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- What the object answered: the client checks each response's tag and id, and decodes its exit.
                try: () => parser.decode(answer) as ReadonlyArray<RpcMessage.FromServerEncoded>,
                catch: (cause) =>
                  clientError(
                    new RpcClientError.RpcClientDefect({
                      message: "Error decoding the object's answer",
                      cause,
                    }),
                  ),
              });

              if (!responses.some(RpcMessage.isTerminalResponse)) {
                return yield* clientError(
                  new RpcClientError.RpcClientDefect({
                    message: "The object's answer ended before the call completed",
                    cause: request,
                  }),
                );
              }

              yield* Effect.forEach(responses, (response) => write(clientId, response), {
                discard: true,
              });
            }),
      supportsAck: false,
      supportsTransferables: false,
      codecFor: json.codecFor,
    }),
  );

/**
 * The `RpcClient.Protocol` `RpcClient.make` and `ActionRpc.client` call an object's rpcs with,
 * over `stub`: each call is one call of the object's `effectActionsRpc` method, speaking
 * JSON, which the object serves on `layerStub`, through `make`'s or `handlers`' `calls`. The
 * stub's own failure, such as an object serving no rpcs over its stub or an answer past the
 * platform's limit, is an `RpcClientError`, as an HTTP transport's is. Unary: an rpc that
 * streams fails as a defect. Nothing authenticates the call: forward a principal as a header,
 * with `RpcClient.withHeaders`, or in the payload.
 *
 * Guide: `docs/ActionDurableObject-stub.md` in this package.
 */
export const layerStubClient = (stub: Stub): Layer.Layer<RpcClient.Protocol> =>
  Layer.effect(RpcClient.Protocol)(makeProtocol(Effect.succeed(stub)));

const CurrentStub = Context.Reference<Stub | undefined>(
  "effect-actions-cloudflare/ActionDurableObject/CurrentStub",
  { defaultValue: () => undefined },
);

const currentStub = Effect.flatMap(Effect.service(CurrentStub), (stub) =>
  stub === undefined ? Effect.die(new Error("No stub for the call")) : Effect.succeed(stub),
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
 * The rpcs of `group` on the objects `stubOf` reaches, as `(key) => client`, for a Worker or an
 * object calling many objects by name: `plugin(id).start()`. One native client, built in the
 * given `Scope`, serves every object, each call going to its key's stub, so nothing is kept per
 * object and an eviction changes nothing. A call fails with the rpc's declared errors; the
 * stub's own failure, which its caller cannot recover from, is a defect. For Effect's own
 * `RpcClientError` typing, use `RpcClient.make` over `layerStubClient`. A group with an rpc that
 * streams is refused as the client is made.
 *
 * Guide: `docs/ActionDurableObject-stub.md` in this package.
 */
export const client = <Rpcs extends Rpc.Any, K>(
  group: RpcGroup.RpcGroup<Rpcs>,
  stubOf: (key: K) => Stub,
): Effect.Effect<
  (key: K) => Client<RpcGroup.RpcGroup<Rpcs>>,
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
    // stub is a reference set around it, and one client serves every object.
    const native: NativeClient = yield* RpcClient.make(group).pipe(
      Effect.provideServiceEffect(RpcClient.Protocol, makeProtocol(currentStub)),
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Erased native client: one method per rpc of the group, by its tag, each taking its payload and options.
      Effect.map((made) => made as NativeClient),
    );

    const tags = [...group.requests.keys()];

    return (key: K) => {
      const stub = stubOf(key);

      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Erased client: one method per rpc of the group, each the native client's, whose declared errors and successes `Client` types; only the transport's `RpcClientError` is moved to the defects.
      return Object.fromEntries(
        tags.map((tag) => [
          tag,
          (...args: Parameters<NativeMethod>) =>
            methodOf(
              native,
              tag,
            )(...args).pipe(
              Effect.provideService(CurrentStub, stub),
              Effect.catchIf(
                (error): error is RpcClientError.RpcClientError =>
                  Predicate.isTagged(error, "RpcClientError"),
                Effect.die,
              ),
            ),
        ]),
      ) as Client<RpcGroup.RpcGroup<Rpcs>>;
    };
  });
