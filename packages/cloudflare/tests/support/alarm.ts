import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { Effect } from "effect";

import { alarmPrefix } from "../../src/durable/alarm.js";

/** Brings every time the object's alarm keeps to now, leaving the runtime's alarm as it was. */
export const dueNow = (stub: DurableObjectStub) =>
  Effect.promise(async () => {
    await runInDurableObject(stub, async (_, state) => {
      const now = Date.now();
      const kept = await state.storage.list<object>({ prefix: alarmPrefix });

      await state.storage.put(
        Object.fromEntries(
          [...kept].map(([key, value]) => [key, { ...value, at: now }])
        )
      );
    });
  });

/**
 * Runs the object's alarm as though every time it keeps had come, as `runDurableObjectAlarm`
 * runs it at once, before any has: answers whether an alarm was set.
 */
export const runAlarmDue = (stub: DurableObjectStub) =>
  Effect.andThen(
    dueNow(stub),
    Effect.promise(async () => await runDurableObjectAlarm(stub))
  );
