import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { Effect } from "effect";

import { alarmPrefix } from "../../src/durable/alarm.js";

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

export const runAlarmDue = (stub: DurableObjectStub) =>
  Effect.andThen(
    dueNow(stub),
    Effect.promise(async () => await runDurableObjectAlarm(stub))
  );
