import { describe, expect, it } from "@effect/vitest";
import { env } from "cloudflare:workers";
import { Effect, Fiber } from "effect";

import { gathered, received } from "../support/worker.js";
import { initialize, Seer } from "../worker.js";

const tags = Effect.map(received, (all) => all.map(({ tag }) => tag));

const receivedTag = (tag: string) => gathered(tags, (all) => all.includes(tag));

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

        yield* received;
        yield* Effect.forkChild(seers("natives-fork").hold());
        yield* receivedTag("holding");

        expect(
          yield* seers("natives-fork").bump().pipe(Effect.timeout("1 second"))
        ).toBe(1);
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

        const interrupting = (id: string, uninterruptible: boolean) =>
          Effect.gen(function* () {
            yield* received;

            const call = yield* Effect.forkChild(
              seers(`natives-${id}`).mark({ id, uninterruptible })
            );

            const started = yield* receivedTag(`marking-${id}`);

            yield* Fiber.interrupt(call);

            return started;
          });

        const kept = yield* interrupting("kept", true);
        const finished = [...kept, ...(yield* receivedTag("mark-kept"))];

        const stopped = yield* interrupting("stopped", false);

        yield* seers("natives-stopped").bump();

        const marked = [...stopped, ...(yield* tags)];

        expect(finished.filter((tag) => tag === "mark-kept")).toHaveLength(1);
        expect(marked.filter((tag) => tag === "mark-stopped")).toHaveLength(0);
      }),
    { timeout: 30_000 }
  );
});
