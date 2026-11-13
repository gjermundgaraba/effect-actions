import * as CloudflareCluster from "@effect/platform-cloudflare/CloudflareCluster";
import { Context, Effect, Layer, Stream } from "effect";
import { ClusterSchema, Sharding } from "effect/cluster";
import { Headers } from "effect/http";

type Answer =
  | Effect.Effect<unknown, unknown, unknown>
  | Stream.Stream<unknown, unknown, unknown>;

type Method = (payload: unknown, options?: unknown) => Answer;

const intact = (answer: Answer) =>
  Effect.isEffect(answer)
    ? Effect.provideService(answer, Headers.CurrentRedactedNames, [])
    : Stream.provideService(answer, Headers.CurrentRedactedNames, []);

/**
 * Effect Cluster on Durable Objects, `CloudflareCluster.layer(options)`, whose entity clients
 * send a volatile call's headers as the caller set them: the `Sharding`, the `WorkflowEngine` and
 * the `PersistedQueueFactory` it provides, its `Sharding`'s entity clients each sending a call of
 * an rpc not annotated `ClusterSchema.Persisted` with `Headers.CurrentRedactedNames` empty.
 * Provide it where `CloudflareCluster.layer` goes, so a credential `ActionEntity.reaching` or
 * `RpcClient.withHeaders` sends reaches the entity. Guide: `docs/ActionCluster.md` in this
 * package.
 *
 * **Gotchas**
 *
 * - `CloudflareCluster.layer`'s own clients send `authorization`, `cookie`, `set-cookie` and `x-api-key` as the text `<redacted>`, so an entity authenticating from its envelope refuses every protected call with `Unauthenticated`: this layer is the fix until Effect sends them intact.
 * - A persisted rpc's call, one whose rpc is annotated `ClusterSchema.Persisted`, as `CloudflareCluster.layer` reads it, is sent as `CloudflareCluster.layer` sends it, redacted, since `cluster_messages` keeps its envelope: its handler receives `<redacted>`, and a protected one is refused with `Unauthenticated`, so authenticate nothing from a persisted tell's headers.
 * - Redaction is off for a volatile call alone, its send and its wait for the answer, in the caller's fiber: the caller's logs before and after it, and the entity's own, still redact those headers.
 */
export const layer = (
  options: CloudflareCluster.LayerOptions
): Layer.Layer<Layer.Success<ReturnType<typeof CloudflareCluster.layer>>> =>
  Layer.effect(Sharding.Sharding)(
    Effect.map(Effect.service(Sharding.Sharding), (sharding) =>
      Sharding.Sharding.of({
        ...sharding,
        makeClient: (entity) =>
          Effect.map(
            sharding.makeClient(entity),
            (clientFor) => (entityId: string) => {
              const client = clientFor(entityId);

              // oxlint-disable-next-line typescript/no-unsafe-type-assertion
              const methods = client as Readonly<
                Record<string, Method | undefined>
              >;

              // oxlint-disable-next-line typescript/no-unsafe-type-assertion
              return Object.fromEntries(
                [...entity.protocol.requests.values()].flatMap((rpc) => {
                  const method = methods[rpc._tag];

                  if (method === undefined) {
                    return [];
                  }

                  return Context.get(rpc.annotations, ClusterSchema.Persisted)
                    ? [[rpc._tag, method] as const]
                    : [
                        [
                          rpc._tag,
                          (payload: unknown, sendOptions?: unknown) =>
                            intact(method(payload, sendOptions)),
                        ] as const,
                      ];
                })
              ) as typeof client;
            }
          ),
      })
    )
  ).pipe(Layer.provideMerge(CloudflareCluster.layer(options)));
