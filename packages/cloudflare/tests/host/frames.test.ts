import { describe, expect, it } from "@effect/vitest";
import * as ActionRpc from "@gjermundgaraba/effect-actions/ActionRpc";
import * as Stored from "@gjermundgaraba/effect-actions/Stored";
import { runInDurableObject } from "cloudflare:test";
import { Effect, Layer, Predicate } from "effect";
import { RpcMessage, RpcSerialization } from "effect/rpc";

import * as ActionWorker from "../../src/host/ActionWorker.js";
import { Board, Pinned } from "../board.js";
import {
  evict,
  objectOf,
  pollOf,
  raw,
  settledStubs,
  stubs,
  until,
  upgrade,
} from "../support/socket.js";
import { Kept, Seer, StreamHeaders } from "../worker.js";

const parser = RpcSerialization.json.makeUnsafe();

const instancesOf = (board: string) =>
  Effect.map(
    stubs,
    ({ instances }) =>
      instances.filter((instance) => instance.includes(board)).length
  );

const made =
  (
    socket: Partial<ActionWorker.Socket>,
    entity: typeof Board | typeof Seer = Board
  ) =>
  () =>
    ActionWorker.make<Cloudflare.Env>({
      entities: [
        {
          entity,
          layer: () => Layer.empty,
          socket: { path: "/:id", ...socket },
        },
      ],
    });

describe("ActionWorker's socket frames", () => {
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
    "answers a parked poll whose rpc a deploy removed with Unknown request tag, at the object's next settle, as a live frame of that tag is",
    () =>
      Effect.gen(function* () {
        const board = "removed-tag";
        const { socket, received } = yield* raw("Board", board);
        const removed = ActionRpc.pollTag("board.removed");

        pollOf(socket, Pinned.name, board)("1", crypto.randomUUID(), null);

        yield* until(
          () => received,
          (messages) => messages.length >= 1
        );

        yield* Effect.promise(async () => {
          await runInDurableObject(objectOf("Board", board), (_, state) => {
            const gate = state.storage.sql.exec(Stored.changeSignal).one()[
              "signal"
            ];

            for (const held of state.getWebSockets()) {
              const attachment: unknown = held.deserializeAttachment();

              if (Predicate.isObject(attachment)) {
                held.serializeAttachment({
                  ...attachment,
                  parked: [
                    {
                      id: "2",
                      tag: removed,
                      payload: { input: { board }, cursor: "0" },
                      headers: [],
                      gate,
                    },
                  ],
                });
              }
            }
          });
        });

        const before = yield* settledStubs;

        socket.send(String(parser.encode(RpcMessage.constEof)));

        yield* until(
          () => received,
          (messages) => messages.length >= 2
        );

        const after = yield* settledStubs;

        expect(received[1]).toContain('"requestId":"2"');
        expect(received[1]).toContain(`Unknown request tag: ${removed}`);
        expect(after.started.invoke).toBe(before.started.invoke);
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

  it.live(
    "answers a frame it cannot read with a defect, and serves the socket after it",
    () =>
      Effect.gen(function* () {
        const board = "unreadable-frames";
        const { socket, received } = yield* raw("Board", board);

        socket.send("{");
        socket.send("null");

        yield* until(
          () => received,
          (messages) => messages.length >= 2
        );

        socket.send(
          JSON.stringify({
            _tag: "Request",
            id: "1",
            tag: "pin",
            payload: { board, n: 1 },
            headers: [],
          })
        );

        yield* until(
          () => received,
          (messages) => messages.length >= 3
        );

        expect(
          received.map(
            (message) => /"_tag":"(?<tag>\w+)"/u.exec(message)?.groups?.["tag"]
          )
        ).toStrictEqual(["Defect", "Defect", "Exit"]);
        expect(received[2]).toContain('"_tag":"Success"');
      }).pipe(Effect.scoped),
    { timeout: 30_000 }
  );

  it.live(
    "answers a page's close with its own code and reason, and forgets the socket",
    () =>
      Effect.gen(function* () {
        const board = "answers-close";
        const { socket } = yield* raw("Board", board);

        const closed = Effect.promise(async () => {
          const { promise, resolve } = Promise.withResolvers<CloseEvent>();

          socket.addEventListener("close", resolve, { once: true });

          return await promise;
        });

        socket.close(4000, "page left");

        const { code, reason, wasClean } = yield* closed.pipe(
          Effect.timeout("5 seconds")
        );

        const left = yield* Effect.promise(
          async () =>
            await runInDurableObject(
              objectOf("Board", board),
              (_, state) => state.getWebSockets().length
            )
        );

        expect({ code, reason, wasClean, left }).toStrictEqual({
          code: 4000,
          reason: "page left",
          wasClean: true,
          left: 0,
        });
      }).pipe(Effect.scoped),
    { timeout: 30_000 }
  );

  it.live(
    "ignores a second close event for a socket that has made a call",
    () =>
      Effect.gen(function* () {
        const board = "closed-twice";
        const { socket: page, received } = yield* raw("Board", board);

        page.send(
          JSON.stringify({
            _tag: "Request",
            id: "1",
            tag: "pin",
            payload: { board, n: 1 },
            headers: [],
          })
        );

        yield* until(
          () => received,
          (messages) => messages.length >= 1
        );

        const outcomes = yield* Effect.promise(
          async () =>
            await runInDurableObject(
              objectOf("Board", board),
              async (instance, state) => {
                const [socket] = state.getWebSockets();

                if (socket === undefined) {
                  return ["no socket"];
                }

                const closes: string[] = [];

                for (let index = 0; index < 2; index += 1) {
                  await instance.webSocketClose?.(socket, 1000, "", true);
                  closes.push("closed");
                }

                return closes;
              }
            )
        );

        expect(outcomes).toStrictEqual(["closed", "closed"]);
      }).pipe(Effect.scoped),
    { timeout: 30_000 }
  );

  it.effect(
    "throws as it runs, before registering, for a socket's refusal code outside 4000 to 4999, a reason past a close frame's 123 bytes, a contract its binding lacks, a streaming action, an entity named twice or a malformed path",
    () =>
      Effect.sync(() => {
        expect(made({ protocol: { version: "1", code: 3999 } })).toThrow(
          "protocol.code 3999 is not an integer from 4000 to 4999"
        );
        expect(
          made({
            protocol: { version: "1", code: 4000, reason: "é".repeat(62) },
          })
        ).toThrow("is 124 bytes, more than the 123 a close frame holds");
        expect(made({ actions: [Pinned, Kept] })).toThrow(
          "lists kept, which Board's binding does not hold"
        );
        expect(() =>
          ActionWorker.make<Cloudflare.Env>({
            entities: [
              { entity: Board, layer: () => Layer.empty },
              {
                entity: Board,
                layer: () => Layer.empty,
                socket: { path: "/:id" },
              },
            ],
          })
        ).toThrow("the entities name Board more than once");
        expect(made({ path: "(" })).toThrow(TypeError);
        expect(made({ actions: [StreamHeaders] }, Seer)).toThrow(
          "lists streamHeaders, a streaming action"
        );
      })
  );
});
