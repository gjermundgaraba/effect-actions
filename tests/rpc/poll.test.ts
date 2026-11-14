import { describe, expect, it } from "@effect/vitest";
import { Effect, Fiber, Layer, Schema, Stream } from "effect";
import { TestRunner } from "effect/cluster";
import { HttpClient } from "effect/http";
import type { Headers } from "effect/http";
import { RpcClient, RpcSerialization, RpcServer } from "effect/rpc";
import { TestClock } from "effect/testing";

import * as Event from "../../src/contract/Event.js";
import * as ActionEntity from "../../src/entity/ActionEntity.js";
import * as ActionRpc from "../../src/rpc/ActionRpc.js";
import * as Testing from "../../src/testing/Testing.js";
import { makeMessages, Posted, settle, texts } from "../support/events.js";
import { overHttp, rpcRoutes, unaryOf } from "../support/rpc.js";

const Board = ActionEntity.make("Board", ActionRpc.make([Posted]), {
  key: { "message.posted": () => "board" },
});

const rpcs = ActionEntity.bindingRpcs(Board);

const decodePoll = Schema.decodeUnknownSync(ActionRpc.Poll);

const postedPoll = ActionRpc.pollTag(Posted.name);

interface Forwarded {
  readonly tag: string;
  readonly cursor?: string | null;
  readonly watch?: string | undefined;
}

type Answer = (
  tag: string,
  payload: Schema.Json,
  headers: Headers.Headers
) => Effect.Effect<Schema.Json>;

const servingWith = <R>(
  forwarded: Forwarded[],
  answer: Effect.Effect<Answer, never, R>
) =>
  RpcServer.layer(rpcs).pipe(
    Layer.provide(
      rpcs.toLayer(
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion
        Effect.map(answer, (answered) =>
          Object.fromEntries(
            [...rpcs.requests.keys()].map(
              (tag) =>
                [
                  tag,
                  (
                    payload: Schema.Json,
                    { headers }: { readonly headers: Headers.Headers }
                  ) =>
                    Effect.suspend(() => {
                      forwarded.push(
                        tag === postedPoll
                          ? { tag, ...decodePoll(payload) }
                          : { tag }
                      );

                      return answered(tag, payload, headers);
                    }),
                ] as const
            )
          )
        ) as never
      )
    )
  );

const signedOut = ActionRpc.make([Posted]);

describe("ActionRpc.client's watch through polls", () => {
  it.live(
    "falls back, with no mode, to the polls of a server serving no stream rpc, as an entity, and releases its watch as it ends",
    () =>
      Effect.gen(function* () {
        const log = makeMessages();
        const forwarded: Forwarded[] = [];

        const toTheEntity = Effect.map(
          Board.client,
          (clientFor): Answer =>
            (tag, payload, headers) =>
              Effect.orDie(
                unaryOf(clientFor("board")[tag]?.(payload, { headers }), tag)
              )
        );

        const received = yield* Effect.gen(function* () {
          const client = yield* ActionRpc.client(signedOut);

          const watching = yield* client
            .watch(Posted, {}, { cursor: "0" })
            .pipe(Stream.take(2), Stream.runCollect, Effect.forkChild);

          yield* Effect.sleep("50 millis");
          log.post("general", "one");
          log.post("general", "two");

          return yield* Fiber.join(watching);
        }).pipe(
          Effect.scoped,
          Effect.provide(
            overHttp(servingWith(forwarded, toTheEntity)).pipe(
              Layer.provideMerge(
                ActionEntity.layer(Board, [log.implementation]).pipe(
                  Layer.provide(Event.layerMemory),
                  Layer.provideMerge(TestRunner.layer)
                )
              )
            )
          )
        );

        expect(texts(received)).toStrictEqual(["one", "two"]);
        expect(forwarded[0]).toMatchObject({ tag: postedPoll, cursor: "0" });
        expect(forwarded.at(-1)).toStrictEqual({
          tag: `${Posted.name}/release`,
        });
      }),
    { timeout: 10_000 }
  );

  it.effect(
    "follows an event through the polls ActionRpc.layer serves beside its stream, with mode poll",
    () =>
      Effect.gen(function* () {
        const log = makeMessages();

        log.post("general", "one");
        log.post("general", "two");

        const received = yield* Effect.gen(function* () {
          const client = yield* ActionRpc.client(signedOut);

          return yield* client
            .watch(Posted, {}, { cursor: "0", mode: "poll" })
            .pipe(Stream.take(2), Stream.runCollect);
        }).pipe(
          Effect.scoped,
          Effect.provide(
            overHttp(
              ActionRpc.layer(signedOut, [log.implementation]).pipe(
                Layer.provide(Event.layerMemory)
              )
            )
          )
        );

        expect(texts(received)).toStrictEqual(["one", "two"]);
      })
  );

  it.effect(
    "sends a poll unanswered for 4 minutes again, from the same cursor and watch",
    () =>
      Effect.gen(function* () {
        const forwarded: Forwarded[] = [];

        const firstHeld = Effect.succeed<Answer>((tag) =>
          forwarded.length === 1
            ? Effect.never
            : Effect.succeed(
                tag === postedPoll
                  ? {
                      events: [],
                      cursor: "0",
                      truncated: false,
                      hasMore: false,
                      nextPollMs: 600_000,
                    }
                  : null
              )
        );

        const polls = yield* Effect.gen(function* () {
          const client = yield* ActionRpc.client(signedOut);

          yield* client
            .watch(Posted, {}, { cursor: "0", mode: "poll" })
            .pipe(Stream.runDrain, Effect.forkScoped);

          yield* settle;
          yield* TestClock.adjust("239 seconds");

          const before = forwarded.length;

          yield* TestClock.adjust("1 second");

          return { before, after: forwarded.length };
        }).pipe(
          Effect.scoped,
          Effect.provide(overHttp(servingWith(forwarded, firstHeld)))
        );

        const [first] = forwarded;

        expect(polls).toStrictEqual({ before: 1, after: 2 });
        expect(first?.watch).toBeTypeOf("string");
        expect(forwarded.slice(0, 2)).toStrictEqual([
          { tag: postedPoll, cursor: "0", watch: first?.watch },
          { tag: postedPoll, cursor: "0", watch: first?.watch },
        ]);
      })
  );

  it.effect(
    "streams, with no mode, from ActionRpc.layer, which serves the stream rpc, sending no poll",
    () =>
      Effect.gen(function* () {
        const log = makeMessages();
        const sent: string[] = [];

        log.post("general", "one");
        log.post("general", "two");

        const recording = Layer.effect(HttpClient.HttpClient)(
          Effect.map(
            HttpClient.HttpClient,
            HttpClient.tapRequest(({ body }) =>
              Effect.sync(() => {
                if (body._tag === "Uint8Array") {
                  sent.push(new TextDecoder().decode(body.body));
                }
              })
            )
          )
        );

        const received = yield* Effect.gen(function* () {
          const client = yield* ActionRpc.client(signedOut);

          return yield* client
            .watch(Posted, {}, { cursor: "0" })
            .pipe(Stream.take(2), Stream.runCollect);
        }).pipe(
          Effect.scoped,
          Effect.provide(
            RpcClient.layerProtocolHttp({ url: "/rpc" }).pipe(
              Layer.provide(RpcSerialization.layerNdjson),
              Layer.provide(
                recording.pipe(
                  Layer.provide(
                    Testing.layer(
                      rpcRoutes(
                        ActionRpc.layer(signedOut, [log.implementation]).pipe(
                          Layer.provide(Event.layerMemory)
                        )
                      )
                    )
                  )
                )
              )
            )
          )
        );

        expect(texts(received)).toStrictEqual(["one", "two"]);
        expect(
          sent.some((body) => body.includes(`"tag":"${Posted.name}"`))
        ).toBe(true);
        expect(sent.some((body) => body.includes(postedPoll))).toBe(false);
      })
  );
});
