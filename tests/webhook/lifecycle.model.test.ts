import { expect, it } from "@effect/vitest";
import { Clock, Effect, Match, Schema } from "effect";
import { TestClock } from "effect/testing";
import { events, makeWorld, passed, secretOf, sent, subscribed, url } from "../support/webhook.js";

const Minutes = (maximum: number) => Schema.Int.check(Schema.isBetween({ minimum: 0, maximum }));

const Command = Schema.Union([
  Schema.TaggedStruct("Subscribe", { ttlMinutes: Schema.NullOr(Minutes(90)) }),
  Schema.TaggedStruct("Unsubscribe", {}),
  Schema.TaggedStruct("Post", {}),
  Schema.TaggedStruct("Advance", { minutes: Minutes(90) }),
]);

const Commands = Schema.Array(Command).check(Schema.isMinLength(1), Schema.isMaxLength(10));

const minute = 60_000;

it.effect.prop(
  "delivers exactly the occurrences posted while a subscription is live, which lasts its clamped grant from its last subscribe, each step whole minutes so a live one outlasts a poll",
  { commands: Commands },
  ({ commands }) => {
    const { world, server } = makeWorld({ maxTtl: "60 minutes" });

    return Effect.gen(function* () {
      let expiresAt = 0;
      let posted = 0;
      const expected: Array<string> = [];

      for (const command of commands) {
        const now = yield* Clock.currentTimeMillis;

        yield* Match.value(command).pipe(
          Match.tagsExhaustive({
            Subscribe: ({ ttlMinutes }) =>
              Effect.gen(function* () {
                const granted =
                  ttlMinutes === null
                    ? 60 * minute
                    : Math.min(Math.max(ttlMinutes, 1), 60) * minute;

                const grant = yield* subscribed(
                  secretOf(1),
                  ttlMinutes === null ? null : ttlMinutes * minute,
                );

                expiresAt = now + granted;

                expect(grant.refreshBefore && Date.parse(grant.refreshBefore)).toBe(expiresAt);
              }),
            Unsubscribe: () =>
              Effect.gen(function* () {
                const response = yield* sent("alice", "unsubscribe", {
                  input: {},
                  delivery: { url },
                });

                expect(response.status).toBe(now < expiresAt ? 204 : 409);

                expiresAt = 0;
              }),
            Post: () =>
              Effect.gen(function* () {
                const id = `c${++posted}`;

                world.changes.push({ id, by: "bob" });

                if (now < expiresAt) expected.push(id);

                yield* passed();
              }),
            Advance: ({ minutes }) => TestClock.adjust(minutes * minute),
          }),
        );
      }

      expect(events(world.received).map(({ eventId }) => eventId)).toEqual(expected);
    }).pipe(Effect.provide(server));
  },
  { timeout: 120_000, arbitrary: { runs: 100 } },
);
