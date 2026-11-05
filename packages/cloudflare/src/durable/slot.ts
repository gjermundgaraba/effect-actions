import { Schema } from "effect";

export const Kept = Schema.Struct({ at: Schema.Finite, failures: Schema.Int });

export type Kept = typeof Kept.Type;

export interface Run {
  readonly retryCount: number;
  readonly scheduledTime: number;
  readonly mark: Kept;
}

export type AlarmSlot =
  | { readonly value: "Idle" }
  | { readonly value: "Scheduled"; readonly at: number }
  | {
      readonly value: "Retrying";
      readonly at: number;
      readonly failures: number;
    }
  | { readonly value: "Running"; readonly run: Run }
  | {
      readonly value: "RunningRescheduled";
      readonly run: Run;
      readonly at: number;
    }
  | { readonly value: "RunningCleared"; readonly run: Run };

interface Due {
  readonly now: number;
  readonly startedAt: number;
  readonly served: boolean;
}

export type SlotEvent =
  | { readonly type: "Replace"; readonly at: number }
  | { readonly type: "NoLaterThan"; readonly at: number }
  | { readonly type: "Clear" }
  | (Due & { readonly type: "Due" })
  | { readonly type: "Succeeded" }
  | { readonly type: "Failed"; readonly endedAt: number };

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
    return { value: "Idle" };
  }

  const failures = retryCount + 1;

  return {
    value: "Running",
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

type In<V extends AlarmSlot["value"]> = Extract<
  AlarmSlot,
  { readonly value: V }
>;

const fromScheduled = (slot: In<"Scheduled">, event: SlotEvent): AlarmSlot => {
  switch (event.type) {
    case "Replace": {
      return event.at === slot.at ? slot : { ...slot, at: event.at };
    }

    case "NoLaterThan": {
      return event.at < slot.at ? { ...slot, at: event.at } : slot;
    }

    case "Clear": {
      return { value: "Idle" };
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
  switch (event.type) {
    case "Replace": {
      return { value: "Scheduled", at: event.at };
    }

    case "NoLaterThan": {
      return event.at < slot.at ? { value: "Scheduled", at: event.at } : slot;
    }

    case "Clear": {
      return { value: "Idle" };
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
  switch (event.type) {
    case "Replace":
    case "NoLaterThan": {
      return { value: "RunningRescheduled", run: slot.run, at: event.at };
    }

    case "Clear": {
      return { value: "RunningCleared", run: slot.run };
    }

    case "Succeeded": {
      return { value: "Idle" };
    }

    case "Failed": {
      return { value: "Retrying", ...retryOf(slot.run, event.endedAt) };
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
  switch (event.type) {
    case "Replace": {
      return event.at === slot.at ? slot : { ...slot, at: event.at };
    }

    case "NoLaterThan": {
      return event.at < slot.at ? { ...slot, at: event.at } : slot;
    }

    case "Clear": {
      return { value: "RunningCleared", run: slot.run };
    }

    case "Succeeded": {
      return { value: "Scheduled", at: slot.at };
    }

    case "Failed": {
      const retry = retryOf(slot.run, event.endedAt);

      return retry.at < slot.at
        ? { value: "Retrying", ...retry }
        : { value: "Scheduled", at: slot.at };
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
  switch (event.type) {
    case "Replace":
    case "NoLaterThan": {
      return { value: "RunningRescheduled", run: slot.run, at: event.at };
    }

    case "Succeeded":
    case "Failed": {
      return { value: "Idle" };
    }

    case "Clear":
    case "Due": {
      return slot;
    }
  }
};

export const transition = (slot: AlarmSlot, event: SlotEvent): AlarmSlot => {
  switch (slot.value) {
    case "Idle": {
      return event.type === "Replace" || event.type === "NoLaterThan"
        ? { value: "Scheduled", at: event.at }
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
      return { value: "RunningCleared", run };
    }

    return kept.at === run.mark.at && kept.failures === run.mark.failures
      ? { value: "Running", run }
      : { value: "RunningRescheduled", run, at: kept.at };
  }

  if (kept === undefined) {
    return { value: "Idle" };
  }

  return kept.failures > 0
    ? { value: "Retrying", at: kept.at, failures: kept.failures }
    : { value: "Scheduled", at: kept.at };
};

export const keptOf = (slot: AlarmSlot): Kept | undefined => {
  switch (slot.value) {
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
  slot.value === "Running" ||
  slot.value === "RunningRescheduled" ||
  slot.value === "RunningCleared"
    ? slot.run
    : undefined;
