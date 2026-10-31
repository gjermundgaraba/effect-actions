import { describe, expect, it } from "@effect/vitest";
import { Option, Schema } from "effect";

import { CallbackCategory } from "../../src/contract/Event.js";
import type { DeliveryStatus } from "../../src/contract/subscribe.js";
import {
  deliveryHealth,
  failingForMs,
  healthOf,
  statusOf,
} from "../../src/webhook/health.js";
import type { Health, HealthEvent } from "../../src/webhook/health.js";

const retryForMs = 10_000;

const machine = deliveryHealth(retryForMs);

const iso = (millis: number) => new Date(millis).toISOString();

const after = (health: Health, ...events: readonly HealthEvent[]) => {
  let current = health;

  for (const event of events) {
    [current] = machine.transition(current, event);
  }

  return current;
};

const failed = (
  at: number,
  category: CallbackCategory = "http_5xx",
  final = false
): HealthEvent => ({ type: "AttemptFailed", category, final, at });

const delivered = (at: number): HealthEvent => ({ type: "Delivered", at });

const refreshed: HealthEvent = { type: "Refreshed" };

const restored = (status: DeliveryStatus) =>
  Option.getOrThrow(healthOf(status));

describe("a subscription's delivery health", () => {
  it("starts its retry budget at a first failure, keeps that start through repeat failures, and clears it at a delivery", () => {
    const failing = after(machine.initialState, failed(1000));
    const repeated = after(failing, failed(3000, "timeout"));

    expect(statusOf(failing)).toStrictEqual({
      active: true,
      lastDeliveryAt: null,
      lastError: "http_5xx",
      failedSince: iso(1000),
    });
    expect(statusOf(repeated)).toStrictEqual({
      active: true,
      lastDeliveryAt: null,
      lastError: "timeout",
      failedSince: iso(1000),
    });
    expect(failingForMs(repeated, 4000)).toBe(3000);
    expect(after(failing, failed(2000))).toBe(failing);
    expect(statusOf(after(repeated, delivered(5000)))).toStrictEqual({
      active: true,
      lastDeliveryAt: iso(5000),
      lastError: null,
    });
  });

  it("suspends at the failure that reaches retryFor, which only a refresh resumes, with a fresh budget", () => {
    const failing = after(machine.initialState, failed(0), failed(9999));
    const suspended = after(failing, failed(retryForMs));
    const resumed = after(suspended, refreshed);

    expect(statusOf(failing).active).toBe(true);
    expect(after(failing, refreshed)).toBe(failing);
    expect(statusOf(suspended)).toStrictEqual({
      active: false,
      lastDeliveryAt: null,
      lastError: "http_5xx",
      failedSince: iso(0),
    });
    expect(failingForMs(suspended, 2 * retryForMs)).toBe(0);
    expect(statusOf(resumed)).toStrictEqual({
      active: true,
      lastDeliveryAt: null,
      lastError: "http_5xx",
    });
    expect(statusOf(after(resumed, failed(20_000))).failedSince).toBe(
      iso(20_000)
    );
  });

  it("resets the budget at a final failure, keeping its category, from delivering and from failing", () => {
    const fromDelivering = after(
      machine.initialState,
      delivered(500),
      failed(1000, "http_4xx", true)
    );

    const fromFailing = after(
      machine.initialState,
      failed(0),
      failed(2000, "http_4xx", true)
    );

    expect(statusOf(fromDelivering)).toStrictEqual({
      active: true,
      lastDeliveryAt: iso(500),
      lastError: "http_4xx",
    });
    expect(statusOf(fromFailing)).toStrictEqual({
      active: true,
      lastDeliveryAt: null,
      lastError: "http_4xx",
    });
    expect(statusOf(after(fromFailing, failed(3000))).failedSince).toBe(
      iso(3000)
    );
  });

  it("refuses a delivery or a failure while suspended, answering the same snapshot", () => {
    const suspended = after(
      machine.initialState,
      failed(0),
      failed(retryForMs)
    );

    expect(after(suspended, delivered(retryForMs + 1))).toBe(suspended);
    expect(after(suspended, failed(retryForMs + 1, "timeout"))).toBe(suspended);
    expect(after(suspended, failed(retryForMs + 1, "http_4xx", true))).toBe(
      suspended
    );
  });

  it("restores no status a subscription never reaches", () => {
    for (const status of [
      { active: false, lastDeliveryAt: null, lastError: "http_5xx" },
      {
        active: true,
        lastDeliveryAt: null,
        lastError: null,
        failedSince: iso(0),
      },
      {
        active: false,
        lastDeliveryAt: null,
        lastError: null,
        failedSince: iso(0),
      },
      {
        active: true,
        lastDeliveryAt: "yesterday",
        lastError: null,
      },
    ] satisfies readonly DeliveryStatus[]) {
      expect(healthOf(status)).toStrictEqual(Option.none());
    }
  });
});

const Wait = Schema.Int.check(
  Schema.isBetween({ minimum: 0, maximum: retryForMs / 2 })
);

const Step = Schema.Union([
  Schema.TaggedStruct("Delivered", { wait: Wait }),
  Schema.TaggedStruct("Outage", {
    wait: Wait,
    attempts: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 6 })),
    category: CallbackCategory,
  }),
  Schema.TaggedStruct("FinalFailure", {
    wait: Wait,
    category: CallbackCategory,
  }),
  Schema.TaggedStruct("Refreshed", {}),
]);

const Steps = Schema.Array(Step).check(Schema.isMaxLength(20));

const eventsOf = (steps: typeof Steps.Type) => {
  let at = 0;

  return steps.flatMap((step): readonly HealthEvent[] => {
    if (step._tag === "Refreshed") {
      return [refreshed];
    }

    const attempts = step._tag === "Outage" ? step.attempts : 1;

    return Array.from({ length: attempts }, () => {
      at += step.wait;

      return step._tag === "Delivered"
        ? delivered(at)
        : failed(at, step.category, step._tag === "FinalFailure");
    });
  });
};

interface Modeled {
  readonly active: boolean;
  readonly lastDeliveryAt: number | null;
  readonly lastError: CallbackCategory | null;
  readonly failedSince: number | undefined;
}

const modeled = (model: Modeled, event: HealthEvent): Modeled => {
  if (event.type === "Refreshed") {
    return model.active
      ? model
      : { ...model, active: true, failedSince: undefined };
  }

  if (!model.active) {
    return model;
  }

  if (event.type === "Delivered") {
    return {
      active: true,
      lastDeliveryAt: event.at,
      lastError: null,
      failedSince: undefined,
    };
  }

  if (event.final) {
    return { ...model, lastError: event.category, failedSince: undefined };
  }

  const failedSince = model.failedSince ?? event.at;

  return {
    ...model,
    active: event.at - failedSince < retryForMs,
    lastError: event.category,
    failedSince,
  };
};

const expectedOf = ({
  active,
  lastDeliveryAt,
  lastError,
  failedSince,
}: Modeled): DeliveryStatus => ({
  active,
  lastDeliveryAt: lastDeliveryAt === null ? null : iso(lastDeliveryAt),
  lastError,
  ...(failedSince === undefined ? {} : { failedSince: iso(failedSince) }),
});

it.prop(
  "answers the status an independent model of active, lastError and failedSince reaches through any sequence of deliveries, outages, final failures and refreshes, and goes on alike from that status restored at any step",
  { steps: Steps },
  ({ steps }) => {
    let health = machine.initialState;

    let model: Modeled = {
      active: true,
      lastDeliveryAt: null,
      lastError: null,
      failedSince: undefined,
    };

    for (const event of eventsOf(steps)) {
      const fromRestored = after(restored(statusOf(health)), event);

      health = after(health, event);
      model = modeled(model, event);

      expect(statusOf(health)).toStrictEqual(expectedOf(model));
      expect(statusOf(fromRestored)).toStrictEqual(statusOf(health));
    }
  }
);
