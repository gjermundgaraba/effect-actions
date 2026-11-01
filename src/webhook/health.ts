import { DateTime, Option } from "effect";

import type { CallbackCategory } from "../contract/Event.js";
import type { DeliveryStatus } from "../contract/subscribe.js";

interface Failed {
  readonly lastDeliveryAt: number | null;
  readonly lastError: CallbackCategory;
  readonly failedSince: number;
}

export type Health =
  | {
      readonly value: "Delivering";
      readonly lastDeliveryAt: number | null;
      readonly lastError: CallbackCategory | null;
    }
  | (Failed & { readonly value: "Failing" })
  | (Failed & { readonly value: "Suspended" });

export type HealthEvent =
  | { readonly type: "Delivered"; readonly at: number }
  | {
      readonly type: "AttemptFailed";
      readonly category: CallbackCategory;
      readonly final: boolean;
      readonly at: number;
    }
  | { readonly type: "Refreshed" };

interface DeliveryHealth {
  readonly initialState: Health;
  readonly transition: (health: Health, event: HealthEvent) => Health;
}

export const deliveryHealth = (retryForMs: number): DeliveryHealth => {
  const spent = (failedSince: number, at: number) =>
    at - failedSince >= retryForMs;

  const transition = (health: Health, event: HealthEvent): Health => {
    const { lastDeliveryAt } = health;

    switch (health.value) {
      case "Delivering": {
        if (event.type === "Refreshed") {
          return health;
        }

        if (event.type === "Delivered") {
          return {
            value: "Delivering",
            lastDeliveryAt: event.at,
            lastError: null,
          };
        }

        if (event.final) {
          return event.category === health.lastError
            ? health
            : { ...health, lastError: event.category };
        }

        return {
          value: spent(event.at, event.at) ? "Suspended" : "Failing",
          lastDeliveryAt,
          lastError: event.category,
          failedSince: event.at,
        };
      }

      case "Failing": {
        if (event.type === "Refreshed") {
          return health;
        }

        if (event.type === "Delivered") {
          return {
            value: "Delivering",
            lastDeliveryAt: event.at,
            lastError: null,
          };
        }

        if (event.final) {
          return {
            value: "Delivering",
            lastDeliveryAt,
            lastError: event.category,
          };
        }

        if (spent(health.failedSince, event.at)) {
          return { ...health, value: "Suspended", lastError: event.category };
        }

        return event.category === health.lastError
          ? health
          : { ...health, lastError: event.category };
      }

      case "Suspended": {
        return event.type === "Refreshed"
          ? { value: "Delivering", lastDeliveryAt, lastError: health.lastError }
          : health;
      }
    }
  };

  const initialState: Health = {
    value: "Delivering",
    lastDeliveryAt: null,
    lastError: null,
  };

  return { initialState, transition };
};

const iso = (millis: number) => DateTime.formatIso(DateTime.makeUnsafe(millis));

const millisOf = (text: string) => {
  const millis = Date.parse(text);

  return Number.isNaN(millis) ? Option.none() : Option.some(millis);
};

export const statusOf = (health: Health): DeliveryStatus => {
  const lastDeliveryAt =
    health.lastDeliveryAt === null ? null : iso(health.lastDeliveryAt);

  if (health.value === "Delivering") {
    return { active: true, lastDeliveryAt, lastError: health.lastError };
  }

  return {
    active: health.value === "Failing",
    lastDeliveryAt,
    lastError: health.lastError,
    failedSince: iso(health.failedSince),
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
        value: "Delivering",
        lastDeliveryAt,
        lastError: status.lastError,
      } satisfies Health;
    }

    return {
      value: status.active ? "Failing" : "Suspended",
      lastDeliveryAt,
      lastError: yield* Option.fromNullOr(status.lastError),
      failedSince: yield* millisOf(status.failedSince),
    } satisfies Health;
  });

export const failingForMs = (health: Health, now: number) =>
  health.value === "Failing" ? now - health.failedSince : 0;
