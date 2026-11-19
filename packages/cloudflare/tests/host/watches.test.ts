import { describe, expect, it } from "@effect/vitest";
import * as ActionRpc from "@gjermundgaraba/effect-actions/ActionRpc";
import { runInDurableObject } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { Effect, Exit, Predicate, Queue, Scope, Stream } from "effect";

import { BoardRpc, Hooked, Logged, Pinned } from "../board.js";
import {
  clientOver,
  connected,
  evict,
  heldIn,
  objectOf,
  opened,
  raw,
  reconnecting,
  settledStubs,
  stubs,
  until,
  watchingIn,
} from "../support/socket.js";
import { boards, following, notes } from "../support/watch.js";
import { throughWorker } from "../support/worker.js";

describe("ActionWorker's socket watches", () => {
  it.live(
    "answers an entity's polls at once where its events are not on Stored.layerEvents, its watch polling at nextPoll",
    () =>
      Effect.gen(function* () {
        const board = "unstored";
        const socket = yield* opened("Tally", board);
        const tally = yield* clientOver(BoardRpc, socket);
        const pins = yield* following(tally.watch(Pinned, { board }));

        yield* Effect.sleep("1 second");

        const before = yield* stubs;

        yield* Effect.sleep("3 seconds");

        const held = yield* heldIn("Tally", board);
        const after = yield* stubs;

        yield* tally.pin({ board, n: 4 });

        expect(yield* notes(pins, 1)).toStrictEqual([{ n: 4 }]);
        expect(held.map(({ parked }) => parked)).toStrictEqual([[]]);
        expect(
          after.started.invoke - before.started.invoke
        ).toBeGreaterThanOrEqual(2);
      }).pipe(Effect.scoped),
    { timeout: 60_000 }
  );

  it.live(
    "lets a page whose socket a lost call closed with 1012 connect again and poll from its cursor, receiving each pin once",
    () =>
      Effect.gen(function* () {
        const board = "cut-resume";
        const http = yield* boards;

        yield* http.pin({ board, n: 1 });

        const scope = yield* Scope.make();

        const protocol = yield* Scope.provide(
          reconnecting("Board", board),
          scope
        );

        const received = yield* Queue.unbounded<number>();

        yield* (yield* clientOver(BoardRpc, { protocol }))
          .watch(Pinned, { board }, { cursor: "0" })
          .pipe(
            Stream.runForEach((item) =>
              item._tag === "Occurrence"
                ? Queue.offer(received, item.data.n)
                : Effect.void
            ),
            Effect.forkIn(scope)
          );

        const first = yield* Queue.take(received).pipe(
          Effect.timeout("20 seconds")
        );

        yield* watchingIn("Board", board, 1);

        yield* Effect.promise(async () => {
          await runInDurableObject(objectOf("Board", board), (_, state) => {
            for (const held of state.getWebSockets()) {
              const attachment: unknown = held.deserializeAttachment();

              if (Predicate.isObject(attachment)) {
                held.serializeAttachment({ ...attachment, calls: ["cut"] });
              }
            }
          });
        });

        yield* evict("Board", board);
        yield* Effect.promise(async () => {
          await objectOf("Board", board).fetch("https://object/");
        });
        yield* watchingIn("Board", board, 1);
        yield* http.pin({ board, n: 2 });

        const second = yield* Queue.take(received).pipe(
          Effect.timeout("20 seconds")
        );

        yield* Effect.sleep("2 seconds");

        const extra = yield* Queue.clear(received);

        yield* Scope.close(scope, Exit.void);

        expect([first, second, extra]).toStrictEqual([1, 2, []]);
      }).pipe(Effect.scoped, Effect.provide(throughWorker)),
    { timeout: 90_000 }
  );

  it.live(
    "accepts an upgrade naming any version, or none, on a socket made without protocol",
    () =>
      Effect.gen(function* () {
        const board = "open";

        const upgraded = (query: string) =>
          Effect.promise(
            async () =>
              await exports.default.fetch(
                `https://worker.example/sockets/Watcher/${board}${query}`,
                { headers: { upgrade: "websocket" } }
              )
          );

        const versioned = yield* upgraded("?protocol=0");

        versioned.webSocket?.accept();
        versioned.webSocket?.close(1000);

        const unversioned = yield* upgraded("");
        const socket = yield* connected(unversioned);
        const watcher = yield* clientOver(BoardRpc, socket);
        const pins = yield* following(watcher.watch(Pinned, { board }));

        yield* watchingIn("Watcher", board, 1);
        yield* watcher.pin({ board, n: 3 });

        expect([unversioned.status, versioned.status]).toStrictEqual([
          101, 101,
        ]);
        expect(yield* notes(pins, 1)).toStrictEqual([{ n: 3 }]);
        expect(socket.closed).toStrictEqual([]);
      }).pipe(Effect.scoped),
    { timeout: 30_000 }
  );

  it.live(
    "serves a socket only the contracts its actions list, answering a call of another Unknown request tag",
    () =>
      Effect.gen(function* () {
        const board = "selected";
        const socket = yield* opened("Watcher", board);
        const watcher = yield* clientOver(BoardRpc, socket);
        const pins = yield* following(watcher.watch(Pinned, { board }));
        const refused = yield* Effect.exit(watcher.soon({ board, n: 1 }));

        const logged = yield* Effect.exit(
          Stream.runHead(
            watcher.watch(Logged, { board }, { mode: "poll" })
          ).pipe(Effect.timeout("10 seconds"))
        );

        yield* watchingIn("Watcher", board, 1);
        yield* watcher.pin({ board, n: 2 });

        expect(String(refused)).toContain("Unknown request tag: soon");
        expect(String(logged)).toContain('Event "board.logged" is not served');
        expect(yield* notes(pins, 1)).toStrictEqual([{ n: 2 }]);
      }).pipe(Effect.scoped),
    { timeout: 30_000 }
  );

  it.live(
    "answers a parked poll of an event its entity binds but its socket no longer lists Unknown request tag, calling no entity",
    () =>
      Effect.gen(function* () {
        const board = "retired";
        const { socket, received } = yield* raw("Watcher", board);

        socket.send(
          JSON.stringify({
            _tag: "Request",
            id: "first",
            tag: "pin",
            payload: { board, n: 1 },
            headers: [],
          })
        );
        yield* until(
          () => received,
          (messages) => messages.length > 0
        );

        yield* Effect.promise(async () => {
          await runInDurableObject(objectOf("Watcher", board), (_, state) => {
            for (const held of state.getWebSockets()) {
              const attachment: unknown = held.deserializeAttachment();

              if (Predicate.isObject(attachment)) {
                held.serializeAttachment({
                  ...attachment,
                  parked: [
                    {
                      id: "retired",
                      tag: ActionRpc.pollTag(Hooked.name),
                      payload: { input: { board }, cursor: "0", watch: "w" },
                      headers: [],
                      gate: -1,
                    },
                  ],
                });
              }
            }
          });
        });

        const before = yield* settledStubs;

        socket.send(
          JSON.stringify({
            _tag: "Request",
            id: "second",
            tag: "pin",
            payload: { board, n: 2 },
            headers: [],
          })
        );

        const answers = yield* until(
          () => received,
          (messages) =>
            messages.some((message) => message.includes('"retired"'))
        );

        expect(
          answers.filter((message) => message.includes('"retired"'))
        ).toHaveLength(1);
        expect(
          answers.find((message) => message.includes('"retired"'))
        ).toContain(`Unknown request tag: ${ActionRpc.pollTag(Hooked.name)}`);
        const after = yield* settledStubs;

        expect(after.finished.invoke - before.finished.invoke).toBe(1);
        expect((yield* heldIn("Watcher", board))[0]?.parked).toStrictEqual([]);
      }).pipe(Effect.scoped),
    { timeout: 30_000 }
  );
});
