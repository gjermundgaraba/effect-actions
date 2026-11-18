import { describe, expect, it } from "@effect/vitest";
import * as Action from "@gjermundgaraba/effect-actions/Action";
import * as Event from "@gjermundgaraba/effect-actions/Event";
import { Effect, Match, Schema } from "effect";

const Appended = Event.make("entry.appended", {
  description: "An entry was appended.",
  payload: { id: Schema.Int },
  caller: Action.Anyone,
});

const page = 3;

interface Entry {
  readonly id: number;
  readonly shown: boolean;
}

const makeEntries = () => {
  const entries: Entry[] = [];

  const source = Event.appended(Appended, {
    newest: () => Effect.sync(() => entries.at(-1)?.id ?? 0),
    after: (_input, id) =>
      Effect.sync(() => {
        const past = entries.filter((entry) => entry.id > id);
        const read = past.slice(0, page);

        return {
          items: read.flatMap((entry) =>
            entry.shown ? [{ id: entry.id }] : []
          ),
          through: read.at(-1)?.id,
          hasMore: past.length > page,
        };
      }),
    id: (data) => data.id,
  });

  return { entries, check: source.check };
};

const Command = Schema.Union([
  Schema.TaggedStruct("Append", {
    skip: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 3 })),
    shown: Schema.Boolean,
  }),
  Schema.TaggedStruct("Read", {
    from: Schema.Union([
      Schema.Literals(["start", "foreign", "ahead", "negative"]),
      Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 30 })),
    ]),
  }),
]);

const Commands = Schema.Array(Command).check(
  Schema.isMinLength(1),
  Schema.isMaxLength(40)
);

describe("Event.appended", () => {
  it.effect.prop(
    "starts a new subscriber after the newest id, answers a cursor up to it with the shown entries of one read past it and the last id read, and anything else with a gap and the newest id",
    { steps: Commands },
    ({ steps }) =>
      Effect.gen(function* () {
        const { entries, check } = makeEntries();
        const minted: string[] = [];
        let next = 1;

        for (const step of steps) {
          if (step._tag === "Append") {
            next += step.skip;
            entries.push({ id: next, shown: step.shown });
            next += 1;
            continue;
          }

          const newest = entries.at(-1)?.id ?? 0;

          const cursor = Match.value(step.from).pipe(
            Match.when("start", () => null),
            Match.when("foreign", () => "another:0"),
            Match.when("ahead", () => String(newest + 1)),
            Match.when("negative", () => "-1"),
            Match.orElse(
              (index) => minted[index % Math.max(minted.length, 1)] ?? null
            )
          );

          const answered = yield* check({}, cursor);
          const at = cursor === null ? Number.NaN : Number(cursor);
          const served = Number.isInteger(at) && at >= 0 && at <= newest;

          if (served) {
            const past = entries.filter((entry) => entry.id > at);
            const read = past.slice(0, page);

            expect(
              answered.events.map(({ eventId, data }) => [eventId, data.id])
            ).toStrictEqual(
              read.flatMap((entry) =>
                entry.shown ? [[String(entry.id), entry.id]] : []
              )
            );
            expect(answered.cursor).toBe(String(read.at(-1)?.id ?? at));
            expect(answered.truncated ?? false).toBe(false);
            expect(answered.hasMore ?? false).toBe(past.length > page);
          } else {
            expect(answered).toMatchObject({
              events: [],
              cursor: String(newest),
              truncated: cursor !== null,
            });
          }

          minted.push(answered.cursor);
        }
      })
  );

  it.effect("answers each page with its nextPoll", () =>
    Effect.gen(function* () {
      const source = Event.appended(Appended, {
        newest: () => Effect.succeed(0),
        after: () => Effect.succeed({ items: [] }),
        id: (data) => data.id,
        notified: true,
        nextPoll: "1 second",
      });

      const pages = [
        yield* source.check({}, null),
        yield* source.check({}, "0"),
      ];

      expect(pages.map((answered) => answered.nextPoll)).toStrictEqual([
        "1 second",
        "1 second",
      ]);
      expect(source.notified).toBe(true);
    })
  );
});
