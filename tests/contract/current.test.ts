import { describe, expect, it } from "@effect/vitest";
import * as Action from "@gjermundgaraba/effect-actions/Action";
import * as ActionHttp from "@gjermundgaraba/effect-actions/ActionHttp";
import * as Event from "@gjermundgaraba/effect-actions/Event";
import * as Testing from "@gjermundgaraba/effect-actions/Testing";
import { Effect, Fiber, Match, Schema, Stream } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import { TestClock } from "effect/testing";

import { settle } from "../support/events.js";

const Key = Schema.Literals(["a", "b"]);

const Status = Event.make("status.changed", {
  description: "A key's status changed.",
  input: { key: Schema.optional(Key) },
  payload: { value: Schema.Int },
  caller: Action.Anyone,
});

type Key = typeof Key.Type;

const makeStatuses = () => {
  const values = new Map<Key | undefined, number>();

  const implementation = Event.implement(Status, {
    current: ({ key }) => Effect.sync(() => ({ value: values.get(key) ?? 0 })),
    key: ({ key }) => key,
  });

  return { values, implementation };
};

const Polled = Schema.fromJsonString(
  Schema.Struct({
    cursor: Schema.String,
    events: Schema.Array(
      Schema.Struct({ eventId: Schema.String, data: Status.payload })
    ),
  })
);

const poll = (key: Key | undefined, cursor: string | null) =>
  HttpClient.execute(
    HttpClientRequest.post("/api/events/status.changed").pipe(
      HttpClientRequest.bodyJsonUnsafe({
        input: key === undefined ? {} : { key },
        cursor,
      })
    )
  ).pipe(
    Effect.flatMap((response) => response.text),
    Effect.flatMap(Schema.decodeUnknownEffect(Polled)),
    Effect.orDie
  );

const Subscriber = Schema.UndefinedOr(Key);

interface Minted {
  readonly cursor: string;
  readonly key: Key | undefined;
  readonly at: number;
}

const Command = Schema.Union([
  Schema.TaggedStruct("Set", { key: Subscriber, value: Schema.Int }),
  Schema.TaggedStruct("Read", {
    key: Subscriber,
    from: Schema.Union([
      Schema.Literals(["start", "foreign"]),
      Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 30 })),
    ]),
  }),
]);

const Commands = Schema.Array(Command).check(
  Schema.isMinLength(1),
  Schema.isMaxLength(40)
);

describe("Event current source", () => {
  it.effect.prop(
    "answers a cursor behind the notifies reaching its key, or another key's, with the value as it is, under an id never given before, and its own cursor with nothing",
    { steps: Commands },
    ({ steps }) =>
      Effect.gen(function* () {
        const statuses = makeStatuses();
        const events = yield* Event.Events;
        const reached = new Map<Key | undefined, number>();
        const minted: Minted[] = [];
        const ids = new Map<string, number>();
        let latest = 0;

        const reachedOf = (key: Key | undefined) => reached.get(key) ?? 0;

        for (const step of steps) {
          if (step._tag === "Set") {
            const { key, value } = step;

            latest = value;

            if (key === undefined) {
              statuses.values.set("a", value);
              statuses.values.set("b", value);
              reached.set("a", reachedOf("a") + 1);
              reached.set("b", reachedOf("b") + 1);
            } else {
              statuses.values.set(key, value);
              reached.set(key, reachedOf(key) + 1);
            }

            statuses.values.set(undefined, latest);
            reached.set(undefined, reachedOf(undefined) + 1);
            yield* events.notify(
              Status,
              key === undefined ? undefined : { key }
            );
            continue;
          }

          const { key } = step;

          const resumed = Match.value(step.from).pipe(
            Match.when("start", () => ({ cursor: null, current: false })),
            Match.when("foreign", () => ({
              cursor: "another:0",
              current: false,
            })),
            Match.orElse((index) => {
              const held = minted[index % Math.max(minted.length, 1)];

              return held === undefined
                ? { cursor: null, current: false }
                : {
                    cursor: held.cursor,
                    current: held.key === key && held.at === reachedOf(key),
                  };
            })
          );

          const page = yield* poll(key, resumed.cursor).pipe(
            Effect.provide(
              Testing.layer(
                ActionHttp.layer(
                  ActionHttp.make([Status]),
                  statuses.implementation
                )
              )
            )
          );

          const answered = page.events.map(({ data }) => data);

          expect(answered).toStrictEqual(
            resumed.current ? [] : [{ value: statuses.values.get(key) ?? 0 }]
          );

          const at = reachedOf(key);
          const seen = `${String(key)}\u0000${page.cursor}`;

          expect(ids.get(seen) ?? at).toBe(at);
          ids.set(seen, at);

          for (const occurrence of page.events) {
            expect(occurrence.eventId).toBe(page.cursor);
          }

          minted.push({ cursor: page.cursor, key, at });
        }
      }).pipe(Effect.provide(Event.layerMemory))
  );

  it.effect(
    "sends a watcher the value first, then after each notify, a value set again included",
    () =>
      Effect.gen(function* () {
        const statuses = makeStatuses();
        const client = yield* Action.client(statuses.implementation);
        const events = yield* Event.Events;

        const watching = yield* client
          .watch(Status, { key: "a" })
          .pipe(Stream.take(3), Stream.runCollect, Effect.forkChild);

        yield* settle;

        for (const value of [1, 0]) {
          statuses.values.set("a", value);
          yield* events.notify(Status, { key: "a" });
          yield* settle;
        }

        const received = yield* Fiber.join(watching);

        expect(
          received.map((item) =>
            item._tag === "Gap" ? "gap" : item.data.value
          )
        ).toStrictEqual([0, 1, 0]);
      }).pipe(Effect.provide(Event.layerMemory))
  );

  it.effect(
    "sends a watcher of one key nothing for a notify of the empty key, another key",
    () =>
      Effect.gen(function* () {
        const statuses = makeStatuses();
        const client = yield* Action.client(statuses.implementation);
        const events = yield* Event.Events;

        const watching = yield* client
          .watch(Status, { key: "a" })
          .pipe(Stream.take(2), Stream.runCollect, Effect.forkChild);

        yield* settle;
        yield* events.notify(Status, { key: "" });
        yield* TestClock.adjust("5 seconds");
        statuses.values.set("a", 1);
        yield* events.notify(Status, { key: "a" });

        const received = yield* Fiber.join(watching);

        expect(
          received.map((item) =>
            item._tag === "Gap" ? "gap" : item.data.value
          )
        ).toStrictEqual([0, 1]);
      }).pipe(Effect.provide(Event.layerMemory))
  );

  it.effect(
    "sends a value written while the value was read, at the read its notify wakes",
    () =>
      Effect.gen(function* () {
        const events = yield* Event.Events;
        let value = 0;

        const racing = Event.implement(Status, {
          current: () =>
            Effect.gen(function* () {
              const read = value;

              if (read === 0) {
                value = 1;
                yield* events.notify(Status);
              }

              return { value: read };
            }),
        });

        const client = yield* Action.client(racing);

        const received = yield* client
          .watch(Status, {})
          .pipe(Stream.take(2), Stream.runCollect, Effect.forkChild);

        yield* settle;

        expect(
          (yield* Fiber.join(received)).map((item) =>
            item._tag === "Gap" ? "gap" : item.data.value
          )
        ).toStrictEqual([0, 1]);
      }).pipe(Effect.provide(Event.layerMemory))
  );
});
