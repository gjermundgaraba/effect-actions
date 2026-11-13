import * as CloudflareCluster from "@effect/platform-cloudflare/CloudflareCluster";
import {
  evictDurableObject,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { Effect, Layer } from "effect";
import { FetchHttpClient } from "effect/http";

export const baseUrl = "https://chat.example";

export const worker = FetchHttpClient.layer.pipe(
  Layer.provide(
    Layer.succeed(FetchHttpClient.Fetch)(
      async (input, init) =>
        await exports.default.fetch(new Request(input, init))
    )
  )
);

export const objectOf = (type: string, id: string) =>
  env.CLUSTER_ENTITY.getByName(CloudflareCluster.encodeName(type, id));

export const rowsIn = (type: string, id: string, query: string) =>
  Effect.promise(
    async () =>
      await runInDurableObject(objectOf(type, id), (_, state) =>
        state.storage.sql
          .exec(query)
          .toArray()
          .map((row) => JSON.stringify(row))
      )
  );

export const sqlIn = (
  type: string,
  id: string,
  statement: string,
  ...bindings: number[]
) =>
  Effect.promise(async () => {
    await runInDurableObject(objectOf(type, id), (_, state) => {
      state.storage.sql.exec(statement, ...bindings);
    });
  });

export const deliverNow = (type: string, id: string, tag: string) =>
  Effect.andThen(
    sqlIn(
      type,
      id,
      `UPDATE cluster_messages SET deliver_at = ? WHERE processed = 0 AND deliver_at IS NOT NULL AND json_extract(envelope, '$.tag') = '${tag}'`,
      Date.now()
    ),
    Effect.promise(async () => await runDurableObjectAlarm(objectOf(type, id)))
  );

export const evict = (type: string, id: string) =>
  Effect.promise(async () => {
    await evictDurableObject(objectOf(type, id));
  });
