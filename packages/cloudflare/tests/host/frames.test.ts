import { describe, expect, it } from "@effect/vitest";
import { runInDurableObject } from "cloudflare:test";
import { Effect, Schedule } from "effect";
import { RpcMessage, RpcSerialization } from "effect/rpc";

import * as ActionClusterEntity from "../../src/host/ActionClusterEntity.js";
import { evict, objectOf, stubs, upgrade } from "../support/socket.js";
import { initialize } from "../worker.js";

const parser = RpcSerialization.json.makeUnsafe();

const raw = (type: string, id: string) =>
  Effect.acquireRelease(
    Effect.flatMap(upgrade(type, id), ({ status, webSocket }) => {
      if (webSocket === null) {
        return Effect.die(new Error(`No WebSocket: ${status}`));
      }

      const received: string[] = [];
      const closed: number[] = [];

      webSocket.addEventListener("message", ({ data }) => {
        received.push(String(data));
      });
      webSocket.addEventListener("close", ({ code }) => {
        closed.push(code);
      });
      webSocket.accept();

      return Effect.succeed({ socket: webSocket, received, closed });
    }),
    ({ socket }) =>
      Effect.sync(() => {
        socket.close(1000);
      })
  );

const until = <A>(read: () => A, done: (value: A) => boolean) =>
  Effect.sync(read).pipe(
    Effect.repeat({ until: done, schedule: Schedule.spaced("50 millis") }),
    Effect.timeout("10 seconds")
  );

const instancesOf = (board: string) =>
  Effect.map(
    stubs,
    ({ instances }) =>
      instances.filter((instance) => instance.includes(board)).length
  );

describe("ActionClusterEntity's frames", () => {
  it.live(
    "fails a call of the entity's native rpc with a defect naming its tag, which it does not forward",
    () =>
      Effect.gen(function* () {
        const { socket, received } = yield* raw("Board", "native");

        socket.send(
          JSON.stringify({
            _tag: "Request",
            id: "1",
            tag: "delayed",
            payload: { n: 1, at: 0 },
            headers: [],
          })
        );

        const [answer] = yield* until(
          () => received,
          (messages) => messages.length > 0
        );

        expect(answer).toContain('"_tag":"Die"');
        expect(answer).toContain("Unknown request tag: delayed");
      }).pipe(Effect.scoped),
    { timeout: 30_000 }
  );

  it.live(
    "fails a call of a streaming action with a defect naming it, which it does not forward",
    () =>
      Effect.gen(function* () {
        const { socket, received } = yield* raw("Seer", "streams");

        socket.send(
          JSON.stringify({
            _tag: "Request",
            id: "1",
            tag: "whoami",
            payload: { room: "streams" },
            headers: [],
          })
        );

        const [answer] = yield* until(
          () => received,
          (messages) => messages.length > 0
        );

        expect(answer).toContain('"_tag":"Die"');
        expect(answer).toContain("whoami is a streaming action");
      }).pipe(Effect.scoped),
    { timeout: 30_000 }
  );

  it.live(
    "fails a call at once whose id its socket's attachment cannot hold, never run",
    () =>
      Effect.gen(function* () {
        const board = "untracked";
        const { socket, received } = yield* raw("Board", board);

        socket.send(
          JSON.stringify({
            _tag: "Request",
            id: "1".repeat(20_000),
            tag: "pin",
            payload: { board, n: 1 },
            headers: [],
          })
        );

        const [answer] = yield* until(
          () => received,
          (messages) => messages.length > 0
        );

        yield* Effect.sleep("1 second");

        const tables = yield* Effect.promise(
          async () =>
            await runInDurableObject(
              objectOf("Board", board),
              (_, state) =>
                state.storage.sql
                  .exec(
                    "SELECT name FROM sqlite_master WHERE name = ?",
                    "board_notes"
                  )
                  .toArray().length
            )
        );

        expect(answer).toMatch(/^[{]"_tag":"Exit".*16 KiB/u);
        expect(tables).toBe(0);
      }).pipe(Effect.scoped),
    { timeout: 30_000 }
  );

  it.live(
    "answers a client's ping without building the evicted object again",
    () =>
      Effect.gen(function* () {
        const board = "pings";
        const { socket, received } = yield* raw("Board", board);

        yield* evict("Board", board);

        const before = yield* instancesOf(board);

        socket.send(String(parser.encode(RpcMessage.constPing)));

        const [answer] = yield* until(
          () => received,
          (messages) => messages.length > 0
        );

        yield* Effect.sleep("1 second");

        expect(answer).toBe(String(parser.encode(RpcMessage.constPong)));
        expect(yield* instancesOf(board)).toBe(before);
      }).pipe(Effect.scoped),
    { timeout: 30_000 }
  );

  it.live(
    "closes a socket whose attachment it cannot read with 1012, at the socket's next message",
    () =>
      Effect.gen(function* () {
        const board = "unreadable";
        const { socket, closed } = yield* raw("Board", board);

        yield* Effect.promise(async () => {
          await runInDurableObject(objectOf("Board", board), (_, state) => {
            for (const held of state.getWebSockets()) {
              held.serializeAttachment({ version: "another deploy's" });
            }
          });
        });

        socket.send(String(parser.encode(RpcMessage.constEof)));

        yield* until(
          () => closed,
          (codes) => codes.length > 0
        );

        expect(closed).toStrictEqual([1012]);
      }).pipe(Effect.scoped),
    { timeout: 30_000 }
  );

  it.live(
    "keeps an upgrade's 12 KB of headers, and answers 20 KB, past the attachment's 16 KiB, 431",
    () =>
      Effect.gen(function* () {
        const refused = yield* upgrade("Board", "headers", {
          "x-large": "a".repeat(20_000),
        });

        const accepted = yield* upgrade("Board", "headers", {
          "x-large": "a".repeat(12_000),
        });

        accepted.webSocket?.accept();
        accepted.webSocket?.close(1000);

        expect([refused.status, accepted.status]).toStrictEqual([431, 101]);
      }).pipe(Effect.scoped),
    { timeout: 30_000 }
  );

  it.effect(
    "throws as the class is made for a refusal code outside 4000 to 4999, or a reason past a close frame's 123 bytes",
    () =>
      Effect.sync(() => {
        expect(() =>
          ActionClusterEntity.make({
            initialize,
            sockets: [],
            protocol: { version: "1", code: 3999 },
          })
        ).toThrow("protocol.code 3999 is not an integer from 4000 to 4999");

        expect(() =>
          ActionClusterEntity.make({
            initialize,
            sockets: [],
            protocol: { version: "1", code: 4000, reason: "é".repeat(62) },
          })
        ).toThrow("is 124 bytes, more than the 123 a close frame holds");
      })
  );
});
