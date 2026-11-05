import { describe, expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";

import { keptOf, runOf, slotOf, transition } from "../../src/durable/slot.js";
import type { Kept, Run, SlotEvent } from "../../src/durable/slot.js";

const hour = 60 * 60 * 1000;

const step = (
  kept: Kept | undefined,
  run: Run | undefined,
  event: SlotEvent
) => {
  const before = slotOf(kept, run);
  const after = transition(before, event);

  return after === before
    ? "unchanged"
    : { kept: keptOf(after), run: runOf(after) };
};

const scheduled = { at: 1000, failures: 0 };
const retrying = { at: 1000, failures: 2 };

const run: Run = {
  retryCount: 0,
  scheduledTime: 1000,
  mark: { at: 3000, failures: 1 },
};

const setDuringRun = { at: 50_000, failures: 0 };

const failedRetry = (retryCount: number) =>
  step(
    { at: 0, failures: retryCount + 1 },
    { retryCount, scheduledTime: 0, mark: { at: 0, failures: retryCount + 1 } },
    { type: "Failed", endedAt: 10_000 }
  );

describe("an owner's slot outside a run", () => {
  it.each([
    [
      "nothing kept",
      undefined,
      { type: "Replace", at: 5000 },
      { at: 5000, failures: 0 },
    ],
    [
      "nothing kept",
      undefined,
      { type: "NoLaterThan", at: 5000 },
      { at: 5000, failures: 0 },
    ],
    [
      "a time",
      scheduled,
      { type: "Replace", at: 5000 },
      { at: 5000, failures: 0 },
    ],
    [
      "a time",
      scheduled,
      { type: "Replace", at: 500 },
      { at: 500, failures: 0 },
    ],
    [
      "a time",
      scheduled,
      { type: "NoLaterThan", at: 500 },
      { at: 500, failures: 0 },
    ],
    [
      "a retry",
      retrying,
      { type: "Replace", at: 5000 },
      { at: 5000, failures: 0 },
    ],
    [
      "a retry",
      retrying,
      { type: "Replace", at: 1000 },
      { at: 1000, failures: 0 },
    ],
    [
      "a retry",
      retrying,
      { type: "NoLaterThan", at: 500 },
      { at: 500, failures: 0 },
    ],
    ["a time", scheduled, { type: "Clear" }, undefined],
    ["a retry", retrying, { type: "Clear" }, undefined],
  ] as const)("keeps for %s and %o: %o", (_, kept, event, next) => {
    expect(step(kept, undefined, event)).toStrictEqual({
      kept: next,
      run: undefined,
    });
  });

  it.each([
    ["nothing kept", undefined, { type: "Clear" }],
    ["a time", scheduled, { type: "Replace", at: 1000 }],
    ["a time", scheduled, { type: "NoLaterThan", at: 1000 }],
    ["a time", scheduled, { type: "NoLaterThan", at: 5000 }],
    ["a retry", retrying, { type: "NoLaterThan", at: 1000 }],
    ["a retry", retrying, { type: "NoLaterThan", at: hour }],
  ] as const)("leaves %s as it is on %o", (_, kept, event) => {
    expect(step(kept, undefined, event)).toBe("unchanged");
  });
});

describe("an owner's slot as this instance runs it", () => {
  const rescheduled = { kept: setDuringRun, run };

  it.each([
    ["its mark", run.mark, { type: "Replace", at: 50_000 }, rescheduled],
    ["its mark", run.mark, { type: "NoLaterThan", at: 50_000 }, rescheduled],
    ["its mark", run.mark, { type: "Clear" }, { kept: undefined, run }],
    [
      "a time set",
      setDuringRun,
      { type: "Replace", at: 60_000 },
      { kept: { at: 60_000, failures: 0 }, run },
    ],
    [
      "a time set",
      setDuringRun,
      { type: "NoLaterThan", at: 40_000 },
      { kept: { at: 40_000, failures: 0 }, run },
    ],
    ["a time set", setDuringRun, { type: "Clear" }, { kept: undefined, run }],
    ["nothing kept", undefined, { type: "Replace", at: 50_000 }, rescheduled],
    [
      "nothing kept",
      undefined,
      { type: "NoLaterThan", at: 50_000 },
      rescheduled,
    ],
  ] as const)("keeps for %s and %o: %o", (_, kept, event, next) => {
    expect(step(kept, run, event)).toStrictEqual(next);
  });

  it.each([
    ["a time set", setDuringRun, { type: "NoLaterThan", at: 60_000 }],
    ["a time set", setDuringRun, { type: "Replace", at: 50_000 }],
    ["nothing kept", undefined, { type: "Clear" }],
  ] as const)("leaves %s as it is on %o", (_, kept, event) => {
    expect(step(kept, run, event)).toBe("unchanged");
  });

  it.each([
    ["its mark", run.mark, undefined],
    ["a time set", setDuringRun, setDuringRun],
    ["nothing kept", undefined, undefined],
  ] as const)(
    "ends a run that succeeds with %s kept, keeping %o",
    (_, kept, next) => {
      expect(step(kept, run, { type: "Succeeded" })).toStrictEqual({
        kept: next,
        run: undefined,
      });
    }
  );

  it.each([
    ["its mark", run.mark, { at: 12_000, failures: 1 }],
    ["a later time set", setDuringRun, { at: 12_000, failures: 1 }],
    [
      "an earlier time set",
      { at: 11_000, failures: 0 },
      { at: 11_000, failures: 0 },
    ],
    [
      "the retry's time set",
      { at: 12_000, failures: 0 },
      { at: 12_000, failures: 0 },
    ],
    ["nothing kept", undefined, undefined],
  ] as const)(
    "ends a run that fails at 10000 with %s kept, keeping %o",
    (_, kept, next) => {
      expect(
        step(kept, run, { type: "Failed", endedAt: 10_000 })
      ).toStrictEqual({
        kept: next,
        run: undefined,
      });
    }
  );

  it("backs a failed retry off, then waits an hour after six", () => {
    expect([1, 5, 6, 9].map(failedRetry)).toStrictEqual([
      { kept: { at: 14_000, failures: 2 }, run: undefined },
      { kept: { at: 74_000, failures: 6 }, run: undefined },
      { kept: { at: 10_000 + hour, failures: 7 }, run: undefined },
      { kept: { at: 10_000 + hour, failures: 10 }, run: undefined },
    ]);
  });
});

describe("an owner's slot when the alarm fires", () => {
  const due = {
    type: "Due",
    now: 1000,
    startedAt: 1500,
    served: true,
  } as const;

  it("runs a time that has come, marked as its first retry from when it starts", () => {
    expect(step(scheduled, undefined, due)).toStrictEqual({
      kept: { at: 3500, failures: 1 },
      run: {
        retryCount: 0,
        scheduledTime: 1000,
        mark: { at: 3500, failures: 1 },
      },
    });
  });

  it("runs a retry that has come as its next retry", () => {
    expect(step(retrying, undefined, due)).toStrictEqual({
      kept: { at: 9500, failures: 3 },
      run: {
        retryCount: 2,
        scheduledTime: 1000,
        mark: { at: 9500, failures: 3 },
      },
    });
  });

  it("runs a kept count below 0 as a time, not a retry", () => {
    expect(step({ at: 1000, failures: -1 }, undefined, due)).toStrictEqual({
      kept: { at: 3500, failures: 1 },
      run: {
        retryCount: 0,
        scheduledTime: 1000,
        mark: { at: 3500, failures: 1 },
      },
    });
  });

  it.each([
    ["a time", scheduled],
    ["a retry", retrying],
  ])("drops %s of an owner the alarm does not run", (_, kept) => {
    expect(step(kept, undefined, { ...due, served: false })).toStrictEqual({
      kept: undefined,
      run: undefined,
    });
  });

  it.each([
    ["nothing kept", undefined],
    ["a later time", { at: 1001, failures: 0 }],
    ["a later retry", { at: 1001, failures: 1 }],
  ])("leaves %s as it is", (_, kept) => {
    expect(step(kept, undefined, due)).toBe("unchanged");
  });

  it.each([
    ["its mark", run.mark],
    ["a time set that has come", { at: 0, failures: 0 }],
    ["nothing kept", undefined],
  ])(
    "does not run an owner again as this instance runs it, with %s kept",
    (_, kept) => {
      expect(step(kept, run, { ...due, now: hour })).toBe("unchanged");
    }
  );
});

describe("an owner's slot read back from storage", () => {
  it.effect.prop(
    "reads a kept record outside a run back as it was kept",
    {
      kept: Schema.Struct({
        at: Schema.Finite,
        failures: Schema.Int.check(
          Schema.isBetween({ minimum: 0, maximum: 10 })
        ),
      }),
    },
    ({ kept }) =>
      Effect.sync(() => {
        expect(keptOf(slotOf(kept, undefined))).toStrictEqual({ ...kept });
        expect(runOf(slotOf(kept, undefined))).toBeUndefined();
      })
  );

  it.each([
    ["its mark", run.mark],
    ["a time set", setDuringRun],
    ["nothing kept", undefined],
  ])("reads a run with %s kept back as it was kept", (_, kept) => {
    const slot = slotOf(kept, run);

    expect([keptOf(slot), runOf(slot)]).toStrictEqual([kept, run]);
  });

  it("reads a run cut off with its instance as a retry, run as the next", () => {
    const running = transition(slotOf(scheduled, undefined), {
      type: "Due",
      now: 1000,
      startedAt: 1000,
      served: true,
    });

    expect(
      step(keptOf(running), undefined, {
        type: "Due",
        now: 3000,
        startedAt: 3000,
        served: true,
      })
    ).toStrictEqual({
      kept: { at: 7000, failures: 2 },
      run: {
        retryCount: 1,
        scheduledTime: 3000,
        mark: { at: 7000, failures: 2 },
      },
    });
  });
});
