import { expect, it } from "@effect/vitest";
import { Effect, Match, Schema } from "effect";
import { TestClock } from "effect/testing";
import { makeLogStore, memoryStorage } from "../../src/contract/log.js";

const maxAge = 1000;

const maxEvents = 4;

const Step = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 600 }));

const Command = Schema.Union([
  Schema.TaggedStruct("Push", { after: Step }),
  Schema.TaggedStruct("Read", {
    after: Step,
    from: Schema.Union([
      Schema.Literals(["start", "foreign", "future", "negative", "extra", "word"]),
      Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 30 })),
    ]),
    limit: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 5 })),
  }),
]);

const Commands = Schema.Array(Command).check(Schema.isMinLength(1), Schema.isMaxLength(40));

const cursorAt = (seq: number) => `epoch:${seq}`;

const logOf = (bounds?: { readonly maxAge?: number; readonly maxEvents?: number }) =>
  makeLogStore<number>(memoryStorage(), bounds, () => "epoch");

it.effect.prop(
  "reads, from any cursor, exactly the kept entries after it, and a gap where one after it is no longer kept or the cursor is not its own",
  { steps: Commands },
  ({ steps }) =>
    Effect.gen(function* () {
      const log = logOf({ maxAge, maxEvents });
      const pushed: Array<{ readonly seq: number; readonly at: number }> = [];
      const minted: Array<{ readonly cursor: string; readonly seq: number }> = [];
      let now = 0;

      const isKept = (entry: { readonly seq: number; readonly at: number }) =>
        entry.seq > pushed.length - maxEvents && entry.at >= now - maxAge;

      for (const step of steps) {
        now += step.after;
        yield* TestClock.adjust(step.after);

        if (step._tag === "Push") {
          yield* log.append({ value: pushed.length + 1, key: undefined });
          pushed.push({ seq: pushed.length + 1, at: now });
          continue;
        }

        const { from, limit } = step;

        const resumed = Match.value(from).pipe(
          Match.when("start", () => ({ cursor: null, seq: pushed.length })),
          Match.when("foreign", () => ({ cursor: "another:1", seq: undefined })),
          Match.when("future", () => ({ cursor: cursorAt(pushed.length + 1), seq: undefined })),
          Match.when("negative", () => ({ cursor: "epoch:-1", seq: undefined })),
          Match.when("extra", () => ({ cursor: "epoch:1:2", seq: undefined })),
          Match.when("word", () => ({ cursor: "epoch:x", seq: undefined })),
          Match.orElse((index) => minted[index % Math.max(minted.length, 1)]),
        );

        if (resumed === undefined) continue;

        const read = yield* log.read(resumed.cursor, limit);
        const kept = pushed.filter(isKept);
        const { seq } = resumed;

        const truncated =
          resumed.cursor !== null &&
          (seq === undefined || pushed.some((entry) => entry.seq > seq && !isKept(entry)));

        const pending =
          truncated || seq === undefined ? kept : kept.filter((entry) => entry.seq > seq);

        const resumedAt =
          truncated || seq === undefined ? (kept[0]?.seq ?? pushed.length + 1) - 1 : seq;

        expect(read.truncated).toBe(truncated);
        expect(read.entries.map((entry) => entry.value?.value)).toEqual(
          pending.slice(0, limit).map((entry) => entry.seq),
        );
        expect(read.hasMore).toBe(pending.length > limit);

        const reached = read.entries.at(-1)?.seq ?? resumedAt;

        expect(read.after).toBe(cursorAt(resumedAt));
        expect(read.cursor).toBe(cursorAt(reached));
        minted.push({ cursor: read.cursor, seq: reached });
      }
    }),
  { arbitrary: { runs: 500 } },
);

it.effect("keeps 10,000 entries of at most 10 minutes where no bounds are given", () =>
  Effect.gen(function* () {
    const counted = logOf();
    const aged = logOf();

    for (let n = 1; n <= 10_000; n += 1) yield* counted.append({ value: n, key: undefined });

    const full = yield* counted.read(cursorAt(0), 1);

    yield* counted.append({ value: 10_001, key: undefined });
    yield* aged.append({ value: 1, key: undefined });

    const countedFrom0 = yield* counted.read(cursorAt(0), 1);
    const countedFrom1 = yield* counted.read(cursorAt(1), 1);

    yield* TestClock.adjust(10 * 60 * 1000);

    const agedAtLimit = yield* aged.read(cursorAt(0), 1);

    yield* TestClock.adjust(1);

    expect([
      full.truncated,
      countedFrom0.truncated,
      countedFrom1.truncated,
      agedAtLimit.truncated,
      (yield* aged.read(cursorAt(0), 1)).truncated,
    ]).toEqual([false, true, false, false, true]);
  }),
);
