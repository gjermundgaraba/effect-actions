import { describe, expect, it } from "@effect/vitest";
import * as ActionHttp from "@gjermundgaraba/effect-actions/ActionHttp";
import { runInDurableObject } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { Duration, Effect, Schedule, Schema } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";

import { RoomHttp } from "../src/Api.js";
import type { DemoRoomName } from "../src/chat/Chat.js";
import {
  baseUrl,
  deliverNow,
  evict,
  objectOf,
  rowsIn,
  worker,
} from "./support.js";

const secret = `whsec_${btoa("chat-rooms-webhook-secret-32byte")}`;

const callbackOf = (path: string) => `https://hooks.example${path}`;

const Received = Schema.Array(
  Schema.Struct({
    url: Schema.String,
    at: Schema.Finite,
    status: Schema.Int,
    headers: Schema.Record(Schema.String, Schema.String),
    body: Schema.String,
  })
);

const Delivered = Schema.fromJsonString(
  Schema.Struct({
    type: Schema.optional(Schema.String),
    name: Schema.optional(Schema.String),
    data: Schema.optional(
      Schema.Struct({ id: Schema.Int, text: Schema.String })
    ),
  })
);

const decodeDelivered = Schema.decodeUnknownSync(Delivered);

const fromReceiver = (path: string, init?: RequestInit) =>
  Effect.promise(async () => {
    const response = await fetch(`https://receiver.test${path}`, init);

    return response.status === 204 ? null : await response.json();
  });

const receivedTo = (url: string) =>
  fromReceiver("/received").pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Received)),
    Effect.orDie,
    Effect.map((all) =>
      all
        .filter((each) => each.url === url)
        .map((each) => ({ ...each, delivered: decodeDelivered(each.body) }))
    )
  );

const receivedAt = (path: string) => receivedTo(callbackOf(path));

const postsAt = (path: string) =>
  Effect.map(receivedAt(path), (all) =>
    all.filter(({ delivered }) => delivered.name === "message.posted")
  );

const answer = (path: string, status: number, times = Infinity) =>
  fromReceiver(
    `/answer?path=${encodeURIComponent(path)}&status=${String(status)}&times=${String(times)}`,
    { method: "POST" }
  );

const signed = async (each: {
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}) => {
  const key = await crypto.subtle.importKey(
    "raw",
    Uint8Array.from(
      atob(secret.slice("whsec_".length)),
      (char) => char.codePointAt(0) ?? 0
    ),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const expected = btoa(
    String.fromCodePoint(
      ...new Uint8Array(
        await crypto.subtle.sign(
          "HMAC",
          key,
          new TextEncoder().encode(
            [
              each.headers["webhook-id"],
              each.headers["webhook-timestamp"],
              each.body,
            ].join(".")
          )
        )
      )
    )
  );

  return (each.headers["webhook-signature"] ?? "")
    .split(" ")
    .includes(`v1,${expected}`);
};

const hookRoute = (
  path: "subscribe" | "unsubscribe",
  body: unknown,
  token?: string
) =>
  Effect.promise(
    async () =>
      await exports.default.fetch(
        `${baseUrl}/api/events/message.posted/${path}`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(token === undefined
              ? {}
              : { authorization: `Bearer ${token}` }),
          },
          body: JSON.stringify(body),
        }
      )
  );

const subscribe = (
  room: DemoRoomName,
  url: string,
  options: { readonly ttlMs?: number } = {}
) =>
  hookRoute(
    "subscribe",
    {
      input: { room },
      delivery: { url, secret },
      ...(options.ttlMs === undefined ? {} : { ttlMs: options.ttlMs }),
    },
    "ada"
  );

const unsubscribe = (room: DemoRoomName, url: string) =>
  hookRoute("unsubscribe", { input: { room }, delivery: { url } }, "ada");

const subscribed = (room: DemoRoomName, path: string) =>
  Effect.acquireRelease(subscribe(room, callbackOf(path)), () =>
    unsubscribe(room, callbackOf(path))
  );

const json = ActionHttp.client(RoomHttp, {
  baseUrl,
  transformClient: HttpClient.mapRequest(HttpClientRequest.bearerToken("ada")),
});

const post = (room: DemoRoomName, text: string) =>
  Effect.flatMap(json, (rooms) => rooms.postMessage({ room, text }));

const within = <A, E>(
  check: Effect.Effect<A, E>,
  until: (value: A) => boolean,
  seconds: number
) =>
  check.pipe(
    Effect.repeat({ until, schedule: Schedule.spaced("200 millis") }),
    Effect.timeoutOrElse({
      duration: Duration.seconds(seconds),
      orElse: () =>
        Effect.die(new Error(`Never held within ${String(seconds)} seconds`)),
    })
  );

const Count = Schema.Array(
  Schema.fromJsonString(Schema.Struct({ count: Schema.Int }))
);

const retryWakesIn = (room: DemoRoomName) =>
  Effect.suspend(() =>
    rowsIn(
      "Room",
      room,
      `SELECT count(*) AS count FROM cluster_messages WHERE processed = 0 AND json_extract(envelope, '$.tag') = 'effect-actions/wake' AND deliver_at < ${String(Date.now() + 60_000)}`
    )
  ).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Count)),
    Effect.map((rows) => rows[0]?.count ?? 0),
    Effect.orDie
  );

const Instances = Schema.Struct({ instances: Schema.Array(Schema.String) });

const instancesOf = (room: DemoRoomName) =>
  Effect.promise(async () => {
    const response = await exports.default.fetch(`${baseUrl}/stub-calls`);

    return await response.json();
  }).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Instances)),
    Effect.orDie,
    Effect.map(({ instances }) =>
      instances.filter((instance) => instance.includes(room))
    )
  );

const storedRowsIn = (room: DemoRoomName) =>
  Effect.promise(
    async () =>
      await runInDurableObject(objectOf("Room", room), (_, state) =>
        state.storage.sql
          .exec<{ name: string }>(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\'"
          )
          .toArray()
          .flatMap(({ name }) =>
            state.storage.sql
              .exec(`SELECT * FROM "${name}"`)
              .toArray()
              .map((row) => ({
                table: name,
                row: Object.values(row)
                  .map((value) =>
                    value instanceof ArrayBuffer
                      ? new TextDecoder().decode(value)
                      : String(value)
                  )
                  .join(" "),
              }))
          )
      )
  );

const ofPosts = (
  all: ReadonlyArray<{
    readonly status: number;
    readonly delivered: typeof Delivered.Type;
  }>
) =>
  all.map(({ status, delivered: { type, data } }) => ({
    status,
    type,
    text: data?.text,
  }));

describe("the rooms' webhooks", () => {
  it.live(
    "delivers a post, signed, from a new instance of the room after its eviction while the delivery waits 10 seconds or more to retry",
    () =>
      Effect.gen(function* () {
        const path = "/hooks/evicted";

        yield* answer(path, 503);

        const answered = yield* subscribed("general", path);
        const posted = yield* post("general", "Before the eviction.");

        yield* within(retryWakesIn("general"), (count) => count > 0, 30);

        const before = yield* instancesOf("general");

        yield* answer(path, 200);
        yield* evict("Room", "general");

        const delivered = yield* within(
          postsAt(path),
          (all) => all.some(({ status }) => status === 200),
          40
        );

        const signatures = yield* Effect.promise(
          async () => await Promise.all(delivered.map(signed))
        );

        expect(answered.status).toBe(200);
        expect(
          delivered.map(({ status, delivered: { data } }) => ({
            status,
            id: data?.id,
            text: data?.text,
          }))
        ).toStrictEqual([
          ...delivered.slice(0, -1).map(() => ({
            status: 503,
            id: posted.id,
            text: "Before the eviction.",
          })),
          { status: 200, id: posted.id, text: "Before the eviction." },
        ]);
        expect(signatures.every(Boolean)).toBe(true);
        expect((yield* instancesOf("general")).length).toBeGreaterThan(
          before.length
        );
      }).pipe(Effect.scoped, Effect.provide(worker)),
    { timeout: 90_000 }
  );

  it.live(
    "sends nothing more once unsubscribed while a delivery waits to retry, its wake due",
    () =>
      Effect.gen(function* () {
        const path = "/hooks/unsubscribed";

        yield* answer(path, 503);
        yield* subscribe("general", callbackOf(path));
        yield* post("general", "Never delivered.");

        yield* within(retryWakesIn("general"), (count) => count > 0, 30);

        const left = yield* unsubscribe("general", callbackOf(path));
        const attempts = (yield* postsAt(path)).length;

        yield* answer(path, 200);
        yield* deliverNow("Room", "general", "effect-actions/wake");
        yield* post("general", "After the unsubscribe.");
        yield* Effect.sleep("5 seconds");

        const after = yield* postsAt(path);

        expect(left.status).toBe(204);
        expect(after).toHaveLength(attempts);
        expect(after.every(({ status }) => status === 503)).toBe(true);
      }).pipe(Effect.provide(worker)),
    { timeout: 60_000 }
  );

  it.live(
    "gives up a post its callback answers 410, POSTing a gap, and delivers the next",
    () =>
      Effect.gen(function* () {
        const path = "/hooks/gone";

        yield* answer(path, 410, 1);
        yield* subscribed("design", path);
        yield* post("design", "Gone.");

        yield* within(
          receivedAt(path),
          (all) => all.some(({ delivered }) => delivered.type === "gap"),
          15
        );

        yield* post("design", "Delivered.");

        const received = yield* within(
          receivedAt(path),
          (all) =>
            all.some(({ delivered }) => delivered.data?.text === "Delivered."),
          15
        );

        expect(
          ofPosts(
            received.filter(
              ({ delivered }) => delivered.type !== "verification"
            )
          )
        ).toStrictEqual([
          { status: 410, type: undefined, text: "Gone." },
          { status: 200, type: "gap", text: undefined },
          { status: 200, type: undefined, text: "Delivered." },
        ]);
      }).pipe(Effect.scoped, Effect.provide(worker)),
    { timeout: 60_000 }
  );

  it.live("refuses a callback at a loopback address before any POST", () =>
    Effect.gen(function* () {
      const url = "https://127.0.0.1/hooks/loopback";
      const refused = yield* subscribe("general", url);

      yield* Effect.sleep("1 second");

      expect(refused.status).toBe(409);
      expect(yield* receivedTo(url)).toStrictEqual([]);
    }).pipe(Effect.provide(worker))
  );

  it.live("refuses a subscribe without a credential, sending no callback", () =>
    Effect.gen(function* () {
      const path = "/hooks/anonymous";

      const refused = yield* hookRoute("subscribe", {
        input: { room: "general" },
        delivery: { url: callbackOf(path), secret },
      });

      yield* Effect.sleep("1 second");

      expect(refused.status).toBe(401);
      expect(yield* receivedAt(path)).toStrictEqual([]);
    }).pipe(Effect.provide(worker))
  );

  it.live(
    "delivers 50 posts in the order they were posted, each signed",
    () =>
      Effect.gen(function* () {
        const path = "/hooks/ordered";

        yield* subscribed("design", path);

        const posted = yield* Effect.forEach(
          Array.from({ length: 50 }, (_, n) => n),
          (n) => post("design", `In order ${String(n)}.`)
        );

        const delivered = yield* within(
          postsAt(path),
          (all) => all.length >= 50,
          60
        );

        const signatures = yield* Effect.promise(
          async () => await Promise.all(delivered.map(signed))
        );

        expect(
          delivered.map(({ delivered: { data } }) => data?.id)
        ).toStrictEqual(posted.map(({ id }) => id));
        expect(signatures.every(Boolean)).toBe(true);
      }).pipe(Effect.scoped, Effect.provide(worker)),
    { timeout: 90_000 }
  );

  it.live(
    "keeps no credential in any row of the room's database, its subscription and wakes included",
    () =>
      Effect.gen(function* () {
        const path = "/hooks/at-rest";

        yield* answer(path, 503);
        yield* subscribed("general", path);
        yield* post("general", "At rest.");

        yield* within(retryWakesIn("general"), (count) => count > 0, 30);

        const rows = yield* storedRowsIn("general");

        expect(
          rows.filter(({ row }) => row.includes(callbackOf(path)))
        ).not.toStrictEqual([]);
        expect(
          rows.filter(({ row }) => row.includes("effect-actions/wake"))
        ).not.toStrictEqual([]);
        expect(
          rows.filter(({ row }) => /authorization|bearer/iu.test(row))
        ).toStrictEqual([]);
      }).pipe(Effect.scoped, Effect.provide(worker)),
    { timeout: 60_000 }
  );

  it.live(
    "keeps a subscribed room awake while its subscription lives, and lets it hibernate once the subscription expired, delivering nothing after",
    () =>
      Effect.gen(function* () {
        const path = "/hooks/expiring";

        yield* subscribe("design", callbackOf(path), { ttlMs: 60_000 });

        const granted = Date.now();

        yield* post("design", "Before the expiry.");
        yield* within(postsAt(path), (all) => all.length > 0, 15);

        const delivering = yield* instancesOf("design");

        yield* Effect.sleep("25 seconds");
        yield* post("design", "While subscribed.");
        yield* within(postsAt(path), (all) => all.length > 1, 15);

        const awake = yield* instancesOf("design");

        yield* Effect.sleep(
          Duration.millis(Math.max(0, granted + 65_000 - Date.now()))
        );
        yield* Effect.sleep("25 seconds");

        const expired = yield* instancesOf("design");

        yield* post("design", "After the expiry.");
        yield* Effect.sleep("5 seconds");

        const after = yield* instancesOf("design");

        expect(awake).toStrictEqual(delivering);
        expect(after.length).toBeGreaterThan(expired.length);
        expect(ofPosts(yield* postsAt(path))).toStrictEqual([
          { status: 200, type: undefined, text: "Before the expiry." },
          { status: 200, type: undefined, text: "While subscribed." },
        ]);
      }).pipe(Effect.provide(worker)),
    { timeout: 150_000 }
  );
});
