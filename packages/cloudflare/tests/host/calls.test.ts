import { describe, expect, it } from "@effect/vitest";
import { runInDurableObject } from "cloudflare:test";
import { Cause, Effect, Exit, Fiber } from "effect";

import { eventually } from "../support/eventually.js";
import {
  clientOver,
  evict,
  heldIn,
  objectOf,
  opened,
} from "../support/socket.js";
import { received } from "../support/worker.js";
import { Seer } from "../worker.js";

const lingered = (seen: string[]) =>
  Effect.map(received, (all) => {
    seen.push(
      ...all.map(({ tag }) => tag).filter((tag) => tag.startsWith("linger-"))
    );

    return seen;
  });

const until = (seen: string[], tag: string) =>
  lingered(seen).pipe(eventually((tags) => tags.includes(tag)));

describe("ActionWorker's socket calls", () => {
  it.live(
    "interrupts a forwarded call its page interrupts, and keeps the socket through the next eviction",
    () =>
      Effect.gen(function* () {
        const room = "interrupted";
        const seen: string[] = [];

        const socket = yield* opened("Seer", room, {
          authorization: "Bearer alice",
        });

        const seer = yield* clientOver(Seer.binding, socket);

        const timedOut = yield* seer
          .linger({ room })
          .pipe(Effect.timeout("500 millis"), Effect.exit);

        yield* until(seen, "linger-interrupted");
        yield* Effect.sleep("2 seconds");
        yield* lingered(seen);

        const held = yield* heldIn("Seer", room);

        yield* evict("Seer", room);

        const after = yield* seer.readHeaders({ room });

        expect(timedOut._tag).toBe("Failure");
        expect(seen).toStrictEqual(["linger-started", "linger-interrupted"]);
        expect(held).toStrictEqual([{ calls: [], parked: [] }]);
        expect(after.headers).toMatchObject({ authorization: "Bearer alice" });
        expect(socket.closed).toStrictEqual([]);
      }).pipe(Effect.scoped),
    { timeout: 60_000 }
  );

  it.live(
    "interrupts a forwarded call when its socket closes",
    () =>
      Effect.gen(function* () {
        const room = "closing";
        const seen: string[] = [];

        const socket = yield* opened("Seer", room, {
          authorization: "Bearer alice",
        });

        yield* (yield* clientOver(Seer.binding, socket))
          .linger({ room })
          .pipe(Effect.ignore, Effect.forkScoped);

        yield* until(seen, "linger-started");
        socket.socket.close(1000);
        yield* until(seen, "linger-interrupted");
        yield* Effect.sleep("2 seconds");

        expect(yield* lingered(seen)).toStrictEqual([
          "linger-started",
          "linger-interrupted",
        ]);
      }).pipe(Effect.scoped),
    { timeout: 60_000 }
  );

  it.live(
    "interrupts a forwarded call when its socket fails",
    () =>
      Effect.gen(function* () {
        const room = "failing";
        const seen: string[] = [];

        const socket = yield* opened("Seer", room, {
          authorization: "Bearer alice",
        });

        yield* (yield* clientOver(Seer.binding, socket))
          .linger({ room })
          .pipe(Effect.ignore, Effect.forkScoped);

        yield* until(seen, "linger-started");

        yield* Effect.promise(async () => {
          await runInDurableObject(
            objectOf("Seer", room),
            async (instance, state) => {
              for (const held of state.getWebSockets()) {
                await instance.webSocketError?.(held, new Error("failed"));
              }
            }
          );
        });

        yield* until(seen, "linger-interrupted");
        yield* Effect.sleep("2 seconds");

        expect(yield* lingered(seen)).toStrictEqual([
          "linger-started",
          "linger-interrupted",
        ]);
      }).pipe(Effect.scoped),
    { timeout: 60_000 }
  );

  it.live(
    "fails a page's call under way when its socket sends a frame the host cannot read, the call running in the entity to its end",
    () =>
      Effect.gen(function* () {
        const room = "unreadable";
        const seen: string[] = [];

        const socket = yield* opened("Seer", room, {
          authorization: "Bearer alice",
        });

        const call = yield* (yield* clientOver(Seer.binding, socket))
          .linger({ room })
          .pipe(Effect.exit, Effect.forkScoped);

        yield* until(seen, "linger-started");
        socket.socket.send("{");

        const exit = yield* Fiber.join(call);
        const whenFailed = [...(yield* lingered(seen))];

        yield* lingered(seen).pipe(eventually((tags) => tags.length > 1));

        expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true);
        expect(whenFailed).toStrictEqual(["linger-started"]);
        expect(seen).toStrictEqual(["linger-started", "linger-ended"]);
      }).pipe(Effect.scoped),
    { timeout: 60_000 }
  );
});
