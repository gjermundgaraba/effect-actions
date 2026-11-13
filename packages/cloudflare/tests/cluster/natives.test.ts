import { describe, expect, it } from "@effect/vitest";
import { env, exports } from "cloudflare:workers";
import { Effect, Fiber, Schedule, Schema } from "effect";

import { initialize, Seer } from "../worker.js";

const received = Effect.promise(
  async () => await exports.default.fetch("https://worker.example/received")
).pipe(
  Effect.flatMap((response) =>
    Effect.promise(async () => await response.json())
  ),
  Effect.flatMap(
    Schema.decodeUnknownEffect(
      Schema.Array(Schema.Struct({ tag: Schema.String }))
    )
  ),
  Effect.map((all) => all.map(({ tag }) => tag)),
  Effect.orDie
);

const marked = (id: string) =>
  Effect.promise(
    async () => await exports.default.fetch("https://worker.example/received")
  ).pipe(
    Effect.flatMap((response) =>
      Effect.promise(async () => await response.json())
    ),
    Effect.flatMap(
      Schema.decodeUnknownEffect(
        Schema.Array(Schema.Struct({ tag: Schema.String }))
      )
    ),
    Effect.map((all) => all.filter(({ tag }) => tag === `mark-${id}`)),
    Effect.orDie
  );

describe("ActionEntity.layer's native rpcs on workerd", () => {
  it.live(
    "build services per entity id for their handlers, and run a handler answering through Rpc.fork beside the entity's other calls",
    () =>
      Effect.gen(function* () {
        const context = yield* Effect.promise(
          async () => await initialize(env)
        );

        const seers = yield* Effect.provideContext(Seer.client, context);

        expect(yield* seers("natives-a").bump()).toBe(1);
        expect(yield* seers("natives-a").bump()).toBe(2);
        expect(yield* seers("natives-b").bump()).toBe(1);

        yield* Effect.forkChild(seers("natives-fork").hold());
        yield* Effect.sleep("200 millis");

        expect(
          yield* seers("natives-fork").bump().pipe(Effect.timeout("1 second"))
        ).toBe(1);
      }),
    { timeout: 30_000 }
  );

  it.live(
    "run a persisted tell an entity sends itself after the call sending it ends, at the default concurrency",
    () =>
      Effect.gen(function* () {
        const context = yield* Effect.promise(
          async () => await initialize(env)
        );

        const seers = yield* Effect.provideContext(Seer.client, context);

        yield* received;
        yield* seers("natives-order").follow({ id: "order" });

        const tags: string[] = [];

        yield* Effect.repeat(
          Effect.map(received, (more) => tags.push(...more)),
          {
            until: () => tags.includes("followed-order"),
            schedule: Schedule.spaced("50 millis"),
          }
        ).pipe(Effect.timeout("5 seconds"));

        expect(tags.filter((tag) => tag.endsWith("-order"))).toStrictEqual([
          "follow-order",
          "followed-order",
        ]);
      }),
    { timeout: 30_000 }
  );

  it.live(
    "finish a handler answering through Rpc.uninterruptible after its caller is interrupted, where a plain one stops",
    () =>
      Effect.gen(function* () {
        const context = yield* Effect.promise(
          async () => await initialize(env)
        );

        const seers = yield* Effect.provideContext(Seer.client, context);

        const interrupted = (id: string, uninterruptible: boolean) =>
          Effect.gen(function* () {
            const call = yield* Effect.forkChild(
              seers(`natives-${id}`).mark({ id, uninterruptible })
            );

            yield* Effect.sleep("150 millis");
            yield* Fiber.interrupt(call);
            yield* Effect.sleep("800 millis");

            return yield* marked(id);
          });

        expect(yield* interrupted("kept", true)).toHaveLength(1);
        expect(yield* interrupted("stopped", false)).toHaveLength(0);
      }),
    { timeout: 30_000 }
  );
});
