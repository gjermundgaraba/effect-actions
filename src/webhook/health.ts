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
      readonly _tag: "Delivering";
      readonly lastDeliveryAt: number | null;
      readonly lastError: CallbackCategory | null;
    }
  | (Failed & { readonly _tag: "Failing" })
  | (Failed & { readonly _tag: "Suspended" });

export type HealthEvent =
  | { readonly _tag: "Delivered"; readonly at: number }
  | {
      readonly _tag: "AttemptFailed";
      readonly category: CallbackCategory;
      readonly final: boolean;
      readonly at: number;
    }
  | { readonly _tag: "Refreshed" };

export const delivering: Health = {
  _tag: "Delivering",
  lastDeliveryAt: null,
  lastError: null,
};

export const healthTransition = (retryForMs: number) => {
  const spent = (failedSince: number, at: number) =>
    at - failedSince >= retryForMs;

  return (health: Health, event: HealthEvent): Health => {
    const { lastDeliveryAt } = health;

    switch (health._tag) {
      case "Delivering": {
        if (event._tag === "Refreshed") {
          return health;
        }

        if (event._tag === "Delivered") {
          return {
            _tag: "Delivering",
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
          _tag: spent(event.at, event.at) ? "Suspended" : "Failing",
          lastDeliveryAt,
          lastError: event.category,
          failedSince: event.at,
        };
      }

      case "Failing": {
        if (event._tag === "Refreshed") {
          return health;
        }

        if (event._tag === "Delivered") {
          return {
            _tag: "Delivering",
            lastDeliveryAt: event.at,
            lastError: null,
          };
        }

        if (event.final) {
          return {
            _tag: "Delivering",
            lastDeliveryAt,
            lastError: event.category,
          };
        }

        if (spent(health.failedSince, event.at)) {
          return { ...health, _tag: "Suspended", lastError: event.category };
        }

        return event.category === health.lastError
          ? health
          : { ...health, lastError: event.category };
      }

      case "Suspended": {
        return event._tag === "Refreshed"
          ? { _tag: "Delivering", lastDeliveryAt, lastError: health.lastError }
          : health;
      }
    }
  };
};

export const iso = (millis: number) =>
  DateTime.formatIso(DateTime.makeUnsafe(millis));

const millisOf = (text: string) => {
  const millis = Date.parse(text);

  return Number.isNaN(millis) ? Option.none() : Option.some(millis);
};

export const statusOf = (health: Health): DeliveryStatus => {
  const lastDeliveryAt =
    health.lastDeliveryAt === null ? null : iso(health.lastDeliveryAt);

  if (health._tag === "Delivering") {
    return { active: true, lastDeliveryAt, lastError: health.lastError };
  }

  return {
    active: health._tag === "Failing",
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
        _tag: "Delivering",
        lastDeliveryAt,
        lastError: status.lastError,
      } satisfies Health;
    }

    return {
      _tag: status.active ? "Failing" : "Suspended",
      lastDeliveryAt,
      lastError: yield* Option.fromNullOr(status.lastError),
      failedSince: yield* millisOf(status.failedSince),
    } satisfies Health;
  });

export const failingForMs = (health: Health, now: number) =>
  health._tag === "Failing" ? now - health.failedSince : 0;
