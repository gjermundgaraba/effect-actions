import { DateTime, Option } from "effect";
import { setup, types } from "xstate/fsm";
import type { FSM, FSMSnapshot } from "xstate/fsm";

import type { CallbackCategory } from "../contract/Event.js";
import type { DeliveryStatus } from "../contract/subscribe.js";

interface Delivering {
  readonly lastDeliveryAt: number | null;
  readonly lastError: CallbackCategory | null;
}

interface Failing {
  readonly lastDeliveryAt: number | null;
  readonly lastError: CallbackCategory;
  readonly failedSince: number;
}

interface Delivered {
  readonly at: number;
}

interface AttemptFailed {
  readonly category: CallbackCategory;
  readonly final: boolean;
  readonly at: number;
}

export type Health =
  | FSMSnapshot<Delivering, "Delivering">
  | FSMSnapshot<Failing, "Failing">
  | FSMSnapshot<Failing, "Suspended">;

export type HealthEvent =
  | (Delivered & { readonly type: "Delivered" })
  | (AttemptFailed & { readonly type: "AttemptFailed" })
  | { readonly type: "Refreshed" };

const healthSetup = setup({
  schemas: {
    events: {
      Delivered: types<Delivered>(),
      AttemptFailed: types<AttemptFailed>(),
      Refreshed: types<object>(),
    },
  },
  states: {
    Delivering: { schemas: { context: types<Delivering>() } },
    Failing: { schemas: { context: types<Failing>() } },
    Suspended: { schemas: { context: types<Failing>() } },
  },
});

export const deliveryHealth = (
  retryForMs: number
): Pick<
  FSM<Health["context"], HealthEvent, Health["value"], Health>,
  "initialState" | "transition"
> => {
  const spent = (failedSince: number, at: number) =>
    at - failedSince >= retryForMs;

  return healthSetup.createFSM({
    initial: "Delivering",
    context: { lastDeliveryAt: null, lastError: null },
    states: {
      Delivering: {
        on: {
          Delivered: ({ event }) => ({
            context: { lastDeliveryAt: event.at, lastError: null },
          }),
          AttemptFailed: ({ event: { category, final, at } }) => {
            if (final) {
              return { context: { lastError: category } };
            }

            return spent(at, at)
              ? {
                  target: "Suspended",
                  context: { lastError: category, failedSince: at },
                }
              : {
                  target: "Failing",
                  context: { lastError: category, failedSince: at },
                };
          },
        },
      },
      Failing: {
        on: {
          Delivered: ({ event }) => ({
            target: "Delivering",
            context: { lastDeliveryAt: event.at, lastError: null },
          }),
          AttemptFailed: ({ context, event: { category, final, at } }) => {
            if (final) {
              return { target: "Delivering", context: { lastError: category } };
            }

            return spent(context.failedSince, at)
              ? { target: "Suspended", context: { lastError: category } }
              : { context: { lastError: category } };
          },
        },
      },
      Suspended: {
        on: { Refreshed: { target: "Delivering" } },
      },
    },
  });
};

const iso = (millis: number) => DateTime.formatIso(DateTime.makeUnsafe(millis));

const millisOf = (text: string) => {
  const millis = Date.parse(text);

  return Number.isNaN(millis) ? Option.none() : Option.some(millis);
};

export const statusOf = ({ value, context }: Health): DeliveryStatus => {
  const lastDeliveryAt =
    context.lastDeliveryAt === null ? null : iso(context.lastDeliveryAt);

  if (value === "Delivering") {
    return { active: true, lastDeliveryAt, lastError: context.lastError };
  }

  return {
    active: value === "Failing",
    lastDeliveryAt,
    lastError: context.lastError,
    failedSince: iso(context.failedSince),
  };
};

export const healthOf = (status: DeliveryStatus): Option.Option<Health> =>
  Option.gen(function* () {
    const lastDeliveryAt =
      status.lastDeliveryAt === null
        ? null
        : yield* millisOf(status.lastDeliveryAt);

    if (status.failedSince === undefined) {
      if (!status.active) {
        return yield* Option.none();
      }

      return {
        status: "active",
        value: "Delivering",
        context: { lastDeliveryAt, lastError: status.lastError },
        output: undefined,
        error: undefined,
      } satisfies Health;
    }

    const context = {
      lastDeliveryAt,
      lastError: yield* Option.fromNullOr(status.lastError),
      failedSince: yield* millisOf(status.failedSince),
    };

    return {
      status: "active",
      value: status.active ? "Failing" : "Suspended",
      context,
      output: undefined,
      error: undefined,
    } satisfies Health;
  });

export const failingForMs = ({ value, context }: Health, now: number) =>
  value === "Failing" ? now - context.failedSince : 0;
