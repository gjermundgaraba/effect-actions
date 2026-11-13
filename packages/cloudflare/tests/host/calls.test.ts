import { describe, expect, it } from "@effect/vitest";
import { Effect, Schedule } from "effect";

import {
  clientOver,
  evict,
  heldIn,
  opened,
  receivedTags,
} from "../support/socket.js";
import { Seer } from "../worker.js";

const lingered = (seen: string[]) =>
  Effect.map(receivedTags, (tags) => {
    seen.push(...tags.filter((tag) => tag.startsWith("linger-")));

    return seen;
  });

const until = (seen: string[], tag: string) =>
  lingered(seen).pipe(
    Effect.repeat({
      until: (tags) => tags.includes(tag),
      schedule: Schedule.spaced("50 millis"),
    }),
    Effect.timeout("10 seconds")
  );

describe("ActionClusterEntity's calls", () => {
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
});
