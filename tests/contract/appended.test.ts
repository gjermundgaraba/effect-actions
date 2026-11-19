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

  const read = (id: number) => {
    const past = entries.filter((entry) => entry.id > id);
    const taken = past.slice(0, page);

    return {
      items: taken.flatMap((entry) => (entry.shown ? [{ id: entry.id }] : [])),
      through: taken.at(-1)?.id,
      hasMore: past.length > page,
    };
  };

  const source = Event.appended(Appended, {
    newest: () => Effect.sync(() => entries.at(-1)?.id ?? 0),
    after: (_input, id) => Effect.sync(() => read(id)),
    id: (data) => data.id,
  });

  return { entries, read, check: source.check };
};

const answering = (read: Event.Appended<typeof Appended>) =>
  Event.appended(Appended, {
    newest: () => Effect.succeed(9),
    after: () => Effect.succeed(read),
    id: (data) => data.id,
  });

const Command = Schema.Union([
  Schema.TaggedStruct("Append", {
    skip: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 3 })),
    shown: Schema.Boolean,
  }),
  Schema.TaggedStruct("Read", {
    from: Schema.Union([
      Schema.Literals([
        "start",
        "foreign",
        "ahead",
        "negative",
        "empty",
        "exponent",
        "padded",
      ]),
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
        const { entries, read, check } = makeEntries();
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
            Match.when("empty", () => ""),
            Match.when("exponent", () => "1e-9999"),
            Match.when("padded", () => `0${newest}`),
            Match.orElse(
              (index) => minted[index % Math.max(minted.length, 1)] ?? null
            )
          );

          const answered = yield* check({}, cursor);
          const spelled = /^(?:0|[1-9][0-9]*)$/u.test(cursor ?? "");
          const at = spelled ? Number(cursor) : Number.NaN;
          const served = spelled && at <= newest;

          if (served) {
            const expected = read(at);

            expect(
              answered.events.map(({ eventId, data }) => [eventId, data.id])
            ).toStrictEqual(
              expected.items.map((data) => [String(data.id), data.id])
            );
            expect(answered.cursor).toBe(String(expected.through ?? at));
            expect(answered.truncated ?? false).toBe(false);
            expect(answered.hasMore ?? false).toBe(expected.hasMore);
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

  it.effect(
    "never answers hasMore on a read that moved the cursor nowhere, and never moves it back before an item it sent",
    () =>
      Effect.gen(function* () {
        const stuck = yield* answering({ items: [], hasMore: true }).check(
          {},
          "4"
        );

        const behind = yield* answering({
          items: [{ id: 6 }, { id: 7 }],
          through: 5,
          hasMore: true,
        }).check({}, "4");

        expect([stuck.cursor, stuck.hasMore]).toStrictEqual(["4", false]);
        expect([behind.cursor, behind.hasMore]).toStrictEqual(["7", true]);
      })
  );

  it.effect("answers each page with its nextPoll", () =>
    Effect.gen(function* () {
      const source = Event.appended(Appended, {
        newest: () => Effect.succeed(0),
        after: () => Effect.succeed({ items: [] }),
        id: (data) => data.id,
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
    })
  );
});
