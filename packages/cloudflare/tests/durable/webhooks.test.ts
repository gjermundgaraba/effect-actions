import {
  env,
  evictDurableObject,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import { Effect, Option, Schema } from "effect";
import { describe, expect, it, vi } from "@effect/vitest";
import { webhookPrefix } from "../../src/durable/webhooks.js";
import { answerKey, Hooked, receivedKey } from "../support/webhooks.js";

const hooking = (name: string) => env.HOOKING.getByName(name);

const secret = `whsec_${btoa(String.fromCharCode(...Array.from({ length: 32 }, (_, at) => at)))}`;

const Body = Schema.fromJsonString(
  Schema.Struct({
    type: Schema.optional(Schema.String),
    data: Schema.optional(Schema.Struct({ text: Schema.String })),
  }),
);

const bodyOf = Schema.decodeUnknownOption(Body);

const Texts = Schema.Array(Schema.String);

const textsOf = Schema.decodeUnknownOption(Texts);

const Kept = Schema.fromJsonString(
  Schema.Struct({ status: Schema.Struct({ failedSince: Schema.optional(Schema.String) }) }),
);

const keptOf = Schema.decodeUnknownOption(Kept);

const timedOf = Schema.decodeUnknownOption(Schema.Struct({ at: Schema.Finite }));

const subscribe = (stub: DurableObjectStub) =>
  Effect.promise(async () => {
    const response = await stub.fetch(`https://object/api/events/${Hooked.name}/subscribe`, {
      method: "POST",
      headers: { authorization: "Bearer ada", "content-type": "application/json" },
      body: JSON.stringify({ input: {}, delivery: { url: "https://hooks.example/ada", secret } }),
    });

    await response.arrayBuffer();

    return response.status;
  });

const posted = (stub: DurableObjectStub) =>
  Effect.promise(() =>
    runInDurableObject(stub, async (_, state) =>
      Option.getOrElse(
        textsOf(await state.storage.get(receivedKey)),
        (): ReadonlyArray<string> => [],
      )
        .flatMap((body) => Option.toArray(bodyOf(body)))
        .flatMap(({ type, data }) => (type === undefined && data !== undefined ? [data.text] : [])),
    ),
  );

const untilPosted = (stub: DurableObjectStub, check: (texts: ReadonlyArray<string>) => boolean) =>
  Effect.promise(() =>
    vi.waitUntil(async () => check(await Effect.runPromise(posted(stub))), {
      timeout: 5_000,
      interval: 10,
    }),
  );

const answering = (stub: DurableObjectStub, status: number) =>
  Effect.promise(() =>
    runInDurableObject(stub, (_, state) => state.storage.put(answerKey, status)),
  );

const failingSince = (stub: DurableObjectStub) =>
  Effect.promise(() =>
    runInDurableObject(stub, async (_, state) =>
      [...(await state.storage.list({ prefix: webhookPrefix })).values()].flatMap((value) =>
        Option.toArray(
          Option.flatMap(keptOf(value), ({ status }) => Option.fromUndefinedOr(status.failedSince)),
        ),
      ),
    ),
  );

const clockAlarm = (stub: DurableObjectStub) =>
  Effect.promise(() =>
    runInDurableObject(stub, (_, state) => state.storage.get("effect-actions/alarm/webhooks")),
  );

const evicted = (stub: DurableObjectStub) => Effect.promise(() => evictDurableObject(stub));

const Record = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Json));

const Status = Schema.Record(Schema.String, Schema.Json);

const recordOf = Schema.decodeUnknownOption(Record);

const statusOf = Schema.decodeUnknownOption(Status);

const failedFor = (stub: DurableObjectStub, ago: number) =>
  Effect.promise(() =>
    runInDurableObject(stub, async (_, state) => {
      const kept = await state.storage.list({ prefix: webhookPrefix });
      const failedSince = new Date(Date.now() - ago).toISOString();

      for (const [key, value] of kept) {
        const record = Option.getOrUndefined(recordOf(value));
        const status = Option.getOrUndefined(statusOf(record?.["status"]));

        if (record !== undefined && status !== undefined) {
          await state.storage.put(
            key,
            Schema.encodeSync(Record)({ ...record, status: { ...status, failedSince } }),
          );
        }
      }
    }),
  );

describe("layerWebhooks", () => {
  it.live(
    "delivers each notified occurrence by webhook, its subscription restored after an eviction",
    () =>
      Effect.gen(function* () {
        const stub = hooking("delivers");

        expect(yield* subscribe(stub)).toBe(200);

        yield* Effect.promise(() => stub.hook("one"));
        yield* untilPosted(stub, (texts) => texts.includes("one"));
        yield* evicted(stub);
        yield* Effect.promise(() => stub.hook("two"));
        yield* untilPosted(stub, (texts) => texts.includes("two"));

        expect(new Set(yield* posted(stub))).toEqual(new Set(["one", "two"]));
      }),
  );

  it.live(
    "keeps its subscriptions and the alarm ending their waits through wipe, delivering on from their cursors",
    () =>
      Effect.gen(function* () {
        const stub = hooking("wiped");

        yield* subscribe(stub);
        yield* Effect.promise(() => stub.hook("one"));
        yield* untilPosted(stub, (texts) => texts.length === 1);
        yield* Effect.promise(() => stub.wipe());

        const alarm = yield* Effect.promise(() =>
          runInDurableObject(stub, (_, state) => state.storage.getAlarm()),
        );

        yield* evicted(stub);
        yield* Effect.promise(() => stub.hook("two"));
        yield* Effect.promise(() => stub.hook("three"));
        yield* untilPosted(stub, (texts) => texts.includes("three"));

        const kept = yield* clockAlarm(stub);

        expect(Option.map(timedOf(kept), ({ at }) => at)).toEqual(Option.some(alarm));
      }),
  );

  it.live(
    "waits for a long retry on the object's alarm, which retries it on the instance waiting, or on the next after an eviction",
    () =>
      Effect.forEach(
        [false, true],
        (evicting) =>
          Effect.gen(function* () {
            const stub = hooking(evicting ? "retried-evicted" : "retried-live");

            yield* subscribe(stub);
            yield* failedFor(stub, 2 * 60 * 1000);
            yield* evicted(stub);
            yield* answering(stub, 500);
            yield* Effect.promise(() => stub.hook("one"));
            yield* untilPosted(stub, (texts) => texts.length === 1);
            yield* Effect.promise(() =>
              vi.waitUntil(
                async () =>
                  Option.exists(
                    timedOf(await Effect.runPromise(clockAlarm(stub))),
                    ({ at }) => at < Date.now() + 10 * 60 * 1000,
                  ),
                { timeout: 5_000, interval: 10 },
              ),
            );

            const attempts = (yield* posted(stub)).length;

            yield* answering(stub, 200);

            if (evicting) yield* evicted(stub);

            expect(yield* Effect.promise(() => runDurableObjectAlarm(stub))).toBe(true);

            yield* untilPosted(stub, (texts) => texts.length > attempts);
            yield* Effect.promise(() =>
              vi.waitUntil(async () => (await Effect.runPromise(failingSince(stub))).length === 0, {
                timeout: 5_000,
                interval: 10,
              }),
            );
          }),
        { discard: true },
      ),
    10_000,
  );
});
