import { env, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { Effect, Option, Schema } from "effect";
import { describe, expect, it, vi } from "@effect/vitest";
import { TestClock } from "effect/testing";
import { alarmPrefix } from "../../src/durable/alarm.js";
import { clockOwner, webhookPrefix } from "../../src/durable/webhooks.js";
import { runAlarmDue } from "../support/alarm.js";
import { textsIn } from "../support/texts.js";
import { answerKey, Hooked, receivedKey } from "../support/webhooks.js";
import type { Hooking } from "../worker.js";

const hooking = (name: string) => env.HOOKING.getByName(name);

const secret = `whsec_${btoa(String.fromCharCode(...Array.from({ length: 32 }, (_, at) => at)))}`;

const Body = Schema.fromJsonString(
  Schema.Struct({
    type: Schema.optional(Schema.String),
    data: Schema.optional(Schema.Struct({ text: Schema.String })),
  }),
);

const bodyOf = Schema.decodeUnknownOption(Body);

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
      (await Effect.runPromise(textsIn(state.storage, receivedKey)))
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
    runInDurableObject(stub, (_, state) => state.storage.get(`${alarmPrefix}${clockOwner}`)),
  );

const heldClockMovedOn = (stub: DurableObjectStub, millis: number) =>
  Effect.promise(() =>
    runInDurableObject(stub, (instance: Hooking) =>
      instance.run(TestClock.setTime(Date.now() + millis)),
    ),
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

  const retryingInTwoMinutes = (stub: ReturnType<typeof hooking>) =>
    Effect.gen(function* () {
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

      return attempts;
    });

  const untilDelivering = (stub: DurableObjectStub) =>
    Effect.promise(() =>
      vi.waitUntil(async () => (await Effect.runPromise(failingSince(stub))).length === 0, {
        timeout: 5_000,
        interval: 10,
      }),
    );

  it.live("ends a long retry's wait at the object's alarm, which retries the delivery", () =>
    Effect.gen(function* () {
      const stub = hooking("retried-at-alarm");
      const attempts = yield* retryingInTwoMinutes(stub);

      yield* heldClockMovedOn(stub, 10 * 60 * 1000);
      yield* runAlarmDue(stub);
      yield* untilPosted(stub, (texts) => texts.length > attempts);
      yield* untilDelivering(stub);
    }),
  );

  it.live(
    "retries a delivery a long wait held on the instance its alarm builds after an eviction, as it restores the subscription",
    () =>
      Effect.gen(function* () {
        const stub = hooking("retried-evicted");
        const attempts = yield* retryingInTwoMinutes(stub);

        yield* evicted(stub);
        yield* runAlarmDue(stub);
        yield* untilPosted(stub, (texts) => texts.length > attempts);
        yield* untilDelivering(stub);
      }),
  );
});
