import { Schema } from "effect";

export const Kept = Schema.Struct({ at: Schema.Finite, failures: Schema.Int });

export type Kept = typeof Kept.Type;

export interface Run {
  readonly retryCount: number;
  readonly scheduledTime: number;
  readonly mark: Kept;
}

export type AlarmSlot =
  | { readonly _tag: "Idle" }
  | { readonly _tag: "Scheduled"; readonly at: number }
  | {
      readonly _tag: "Retrying";
      readonly at: number;
      readonly failures: number;
    }
  | { readonly _tag: "Running"; readonly run: Run }
  | {
      readonly _tag: "RunningRescheduled";
      readonly run: Run;
      readonly at: number;
    }
  | { readonly _tag: "RunningCleared"; readonly run: Run };

interface Due {
  readonly now: number;
  readonly startedAt: number;
  readonly served: boolean;
}

export type SlotEvent =
  | { readonly _tag: "Replace"; readonly at: number }
  | { readonly _tag: "NoLaterThan"; readonly at: number }
  | { readonly _tag: "Clear" }
  | (Due & { readonly _tag: "Due" })
  | { readonly _tag: "Succeeded" }
  | { readonly _tag: "Failed"; readonly endedAt: number };

const backoffRetries = 6;

const hour = 60 * 60 * 1000;

export const retryDelay = (failures: number) =>
  failures > backoffRetries ? hour : 2000 * 2 ** (failures - 1);

const dueAt = (
  slot: AlarmSlot,
  at: number,
  retryCount: number,
  event: Due
): AlarmSlot => {
  if (at > event.now) {
    return slot;
  }

  if (!event.served) {
    return { _tag: "Idle" };
  }

  const failures = retryCount + 1;

  return {
    _tag: "Running",
    run: {
      retryCount,
      scheduledTime: at,
      mark: { at: event.startedAt + retryDelay(failures), failures },
    },
  };
};

const retryOf = ({ mark }: Run, endedAt: number) => ({
  at: endedAt + retryDelay(mark.failures),
  failures: mark.failures,
});

type In<V extends AlarmSlot["_tag"]> = Extract<AlarmSlot, { readonly _tag: V }>;

const fromScheduled = (slot: In<"Scheduled">, event: SlotEvent): AlarmSlot => {
  switch (event._tag) {
    case "Replace": {
      return event.at === slot.at ? slot : { ...slot, at: event.at };
    }

    case "NoLaterThan": {
      return event.at < slot.at ? { ...slot, at: event.at } : slot;
    }

    case "Clear": {
      return { _tag: "Idle" };
    }

    case "Due": {
      return dueAt(slot, slot.at, 0, event);
    }

    case "Succeeded":
    case "Failed": {
      return slot;
    }
  }
};

const fromRetrying = (slot: In<"Retrying">, event: SlotEvent): AlarmSlot => {
  switch (event._tag) {
    case "Replace": {
      return { _tag: "Scheduled", at: event.at };
    }

    case "NoLaterThan": {
      return event.at < slot.at ? { _tag: "Scheduled", at: event.at } : slot;
    }

    case "Clear": {
      return { _tag: "Idle" };
    }

    case "Due": {
      return dueAt(slot, slot.at, slot.failures, event);
    }

    case "Succeeded":
    case "Failed": {
      return slot;
    }
  }
};

const fromRunning = (slot: In<"Running">, event: SlotEvent): AlarmSlot => {
  switch (event._tag) {
    case "Replace":
    case "NoLaterThan": {
      return { _tag: "RunningRescheduled", run: slot.run, at: event.at };
    }

    case "Clear": {
      return { _tag: "RunningCleared", run: slot.run };
    }

    case "Succeeded": {
      return { _tag: "Idle" };
    }

    case "Failed": {
      return { _tag: "Retrying", ...retryOf(slot.run, event.endedAt) };
    }

    case "Due": {
      return slot;
    }
  }
};

const fromRunningRescheduled = (
  slot: In<"RunningRescheduled">,
  event: SlotEvent
): AlarmSlot => {
  switch (event._tag) {
    case "Replace": {
      return event.at === slot.at ? slot : { ...slot, at: event.at };
    }

    case "NoLaterThan": {
      return event.at < slot.at ? { ...slot, at: event.at } : slot;
    }

    case "Clear": {
      return { _tag: "RunningCleared", run: slot.run };
    }

    case "Succeeded": {
      return { _tag: "Scheduled", at: slot.at };
    }

    case "Failed": {
      const retry = retryOf(slot.run, event.endedAt);

      return retry.at < slot.at
        ? { _tag: "Retrying", ...retry }
        : { _tag: "Scheduled", at: slot.at };
    }

    case "Due": {
      return slot;
    }
  }
};

const fromRunningCleared = (
  slot: In<"RunningCleared">,
  event: SlotEvent
): AlarmSlot => {
  switch (event._tag) {
    case "Replace":
    case "NoLaterThan": {
      return { _tag: "RunningRescheduled", run: slot.run, at: event.at };
    }

    case "Succeeded":
    case "Failed": {
      return { _tag: "Idle" };
    }

    case "Clear":
    case "Due": {
      return slot;
    }
  }
};

export const transition = (slot: AlarmSlot, event: SlotEvent): AlarmSlot => {
  switch (slot._tag) {
    case "Idle": {
      return event._tag === "Replace" || event._tag === "NoLaterThan"
        ? { _tag: "Scheduled", at: event.at }
        : slot;
    }

    case "Scheduled": {
      return fromScheduled(slot, event);
    }

    case "Retrying": {
      return fromRetrying(slot, event);
    }

    case "Running": {
      return fromRunning(slot, event);
    }

    case "RunningRescheduled": {
      return fromRunningRescheduled(slot, event);
    }

    case "RunningCleared": {
      return fromRunningCleared(slot, event);
    }
  }
};

export const slotOf = (
  kept: Kept | undefined,
  run: Run | undefined
): AlarmSlot => {
  if (run !== undefined) {
    if (kept === undefined) {
      return { _tag: "RunningCleared", run };
    }

    return kept.at === run.mark.at && kept.failures === run.mark.failures
      ? { _tag: "Running", run }
      : { _tag: "RunningRescheduled", run, at: kept.at };
  }

  if (kept === undefined) {
    return { _tag: "Idle" };
  }

  return kept.failures > 0
    ? { _tag: "Retrying", at: kept.at, failures: kept.failures }
    : { _tag: "Scheduled", at: kept.at };
};

export const keptOf = (slot: AlarmSlot): Kept | undefined => {
  switch (slot._tag) {
    case "Idle":
    case "RunningCleared": {
      return undefined;
    }

    case "Scheduled":
    case "RunningRescheduled": {
      return { at: slot.at, failures: 0 };
    }

    case "Retrying": {
      return { at: slot.at, failures: slot.failures };
    }

    case "Running": {
      return slot.run.mark;
    }
  }
};

export const runOf = (slot: AlarmSlot): Run | undefined =>
  slot._tag === "Running" ||
  slot._tag === "RunningRescheduled" ||
  slot._tag === "RunningCleared"
    ? slot.run
    : undefined;
