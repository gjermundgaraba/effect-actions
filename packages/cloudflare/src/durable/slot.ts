import { Schema } from "effect";
import { setup, types } from "xstate/fsm";
import type { FSM, FSMSnapshot } from "xstate/fsm";

export const Kept = Schema.Struct({ at: Schema.Finite, failures: Schema.Int });

export type Kept = typeof Kept.Type;

export interface Run {
  readonly retryCount: number;
  readonly scheduledTime: number;
  readonly mark: Kept;
}

interface Scheduled {
  readonly at: number;
}

interface Retrying {
  readonly at: number;
  readonly failures: number;
}

interface Rescheduled extends Run {
  readonly at: number;
}

interface Due {
  readonly now: number;
  readonly startedAt: number;
  readonly served: boolean;
}

export type AlarmSlot =
  | FSMSnapshot<object, "Idle">
  | FSMSnapshot<Scheduled, "Scheduled">
  | FSMSnapshot<Retrying, "Retrying">
  | FSMSnapshot<Run, "Running">
  | FSMSnapshot<Rescheduled, "RunningRescheduled">
  | FSMSnapshot<Run, "RunningCleared">;

export type SlotEvent =
  | (Scheduled & { readonly type: "Replace" })
  | (Scheduled & { readonly type: "NoLaterThan" })
  | { readonly type: "Clear" }
  | (Due & { readonly type: "Due" })
  | { readonly type: "Succeeded" }
  | { readonly type: "Failed"; readonly endedAt: number };

const backoffRetries = 6;

const hour = 60 * 60 * 1000;

export const retryDelay = (failures: number) =>
  failures > backoffRetries ? hour : 2000 * 2 ** (failures - 1);

const slotSetup = setup({
  schemas: {
    events: {
      Replace: types<Scheduled>(),
      NoLaterThan: types<Scheduled>(),
      Clear: types<object>(),
      Due: types<Due>(),
      Succeeded: types<object>(),
      Failed: types<{ readonly endedAt: number }>(),
    },
  },
  states: {
    Idle: { schemas: { context: types<object>() } },
    Scheduled: { schemas: { context: types<Scheduled>() } },
    Retrying: { schemas: { context: types<Retrying>() } },
    Running: { schemas: { context: types<Run>() } },
    RunningRescheduled: { schemas: { context: types<Rescheduled>() } },
    RunningCleared: { schemas: { context: types<Run>() } },
  },
});

const dueAt = (at: number, retryCount: number, event: Due) => {
  if (at > event.now) {
    return undefined;
  }

  if (!event.served) {
    return { target: "Idle" } as const;
  }

  const failures = retryCount + 1;

  return {
    target: "Running",
    context: {
      retryCount,
      scheduledTime: at,
      mark: { at: event.startedAt + retryDelay(failures), failures },
    },
  } as const;
};

const retryOf = ({ mark }: Run, endedAt: number) => ({
  at: endedAt + retryDelay(mark.failures),
  failures: mark.failures,
});

export const alarmSlot: Pick<
  FSM<AlarmSlot["context"], SlotEvent, AlarmSlot["value"], AlarmSlot>,
  "transition"
> = slotSetup.createFSM({
  initial: "Idle",
  context: {},
  states: {
    Idle: {
      on: {
        Replace: ({ event }) => ({
          target: "Scheduled",
          context: { at: event.at },
        }),
        NoLaterThan: ({ event }) => ({
          target: "Scheduled",
          context: { at: event.at },
        }),
      },
    },
    Scheduled: {
      on: {
        Replace: ({ event }) => ({ context: { at: event.at } }),
        NoLaterThan: ({ context, event }) =>
          event.at < context.at ? { context: { at: event.at } } : undefined,
        Clear: { target: "Idle" },
        Due: ({ context, event }) => dueAt(context.at, 0, event),
      },
    },
    Retrying: {
      on: {
        Replace: ({ event }) => ({
          target: "Scheduled",
          context: { at: event.at },
        }),
        NoLaterThan: ({ context, event }) =>
          event.at < context.at
            ? { target: "Scheduled", context: { at: event.at } }
            : undefined,
        Clear: { target: "Idle" },
        Due: ({ context, event }) => dueAt(context.at, context.failures, event),
      },
    },
    Running: {
      on: {
        Replace: ({ event }) => ({
          target: "RunningRescheduled",
          context: { at: event.at },
        }),
        NoLaterThan: ({ event }) => ({
          target: "RunningRescheduled",
          context: { at: event.at },
        }),
        Clear: { target: "RunningCleared" },
        Succeeded: { target: "Idle" },
        Failed: ({ context, event }) => ({
          target: "Retrying",
          context: retryOf(context, event.endedAt),
        }),
      },
    },
    RunningRescheduled: {
      on: {
        Replace: ({ event }) => ({ context: { at: event.at } }),
        NoLaterThan: ({ context, event }) =>
          event.at < context.at ? { context: { at: event.at } } : undefined,
        Clear: { target: "RunningCleared" },
        Succeeded: { target: "Scheduled" },
        Failed: ({ context, event }) => {
          const retry = retryOf(context, event.endedAt);

          return retry.at < context.at
            ? { target: "Retrying", context: retry }
            : { target: "Scheduled" };
        },
      },
    },
    RunningCleared: {
      on: {
        Replace: ({ event }) => ({
          target: "RunningRescheduled",
          context: { at: event.at },
        }),
        NoLaterThan: ({ event }) => ({
          target: "RunningRescheduled",
          context: { at: event.at },
        }),
        Succeeded: { target: "Idle" },
        Failed: { target: "Idle" },
      },
    },
  },
});

const active = {
  status: "active",
  output: undefined,
  error: undefined,
} as const;

export const slotOf = (kept: Kept | undefined, run: Run | undefined) => {
  if (run !== undefined) {
    const { retryCount, scheduledTime, mark } = run;
    const context = { retryCount, scheduledTime, mark };

    if (kept === undefined) {
      return {
        ...active,
        value: "RunningCleared",
        context,
      } satisfies AlarmSlot;
    }

    return kept.at === mark.at && kept.failures === mark.failures
      ? ({ ...active, value: "Running", context } satisfies AlarmSlot)
      : ({
          ...active,
          value: "RunningRescheduled",
          context: { ...context, at: kept.at },
        } satisfies AlarmSlot);
  }

  if (kept === undefined) {
    return { ...active, value: "Idle", context: {} } satisfies AlarmSlot;
  }

  return kept.failures > 0
    ? ({
        ...active,
        value: "Retrying",
        context: { at: kept.at, failures: kept.failures },
      } satisfies AlarmSlot)
    : ({
        ...active,
        value: "Scheduled",
        context: { at: kept.at },
      } satisfies AlarmSlot);
};

export const keptOf = ({ value, context }: AlarmSlot): Kept | undefined => {
  switch (value) {
    case "Idle":
    case "RunningCleared": {
      return undefined;
    }

    case "Scheduled":
    case "RunningRescheduled": {
      return { at: context.at, failures: 0 };
    }

    case "Retrying": {
      return { at: context.at, failures: context.failures };
    }

    case "Running": {
      return context.mark;
    }
  }
};

export const runOf = ({ value, context }: AlarmSlot): Run | undefined => {
  if (
    value === "Running" ||
    value === "RunningRescheduled" ||
    value === "RunningCleared"
  ) {
    const { retryCount, scheduledTime, mark } = context;

    return { retryCount, scheduledTime, mark };
  }

  return undefined;
};
