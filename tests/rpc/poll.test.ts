import { describe, expect, it } from "@effect/vitest";
import { Effect, Fiber, Layer, Schema, Stream } from "effect";
import { TestRunner } from "effect/cluster";
import type { Headers } from "effect/http";
import { RpcServer } from "effect/rpc";
import { TestClock } from "effect/testing";

import * as Event from "../../src/contract/Event.js";
import * as ActionEntity from "../../src/entity/ActionEntity.js";
import * as ActionRpc from "../../src/rpc/ActionRpc.js";
import { makeMessages, Posted, settle, texts } from "../support/events.js";
import { overHttp } from "../support/rpc.js";

const Board = ActionEntity.make("Board", ActionRpc.make([Posted]), {
  key: { "message.posted": () => "board" },
});

const rpcs = ActionEntity.bindingRpcs(Board);

const PollPayload = Schema.Struct({
  cursor: Schema.NullOr(Schema.String),
  watch: Schema.optional(Schema.String),
});

const decodePoll = Schema.decodeUnknownSync(PollPayload);

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
                        tag === Posted.name
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

describe("ActionRpc.client with delivery poll", () => {
  it.live(
    "follows an event through the polls an entity serves, and releases its watch as it ends",
    () =>
      Effect.gen(function* () {
        const log = makeMessages();
        const forwarded: Forwarded[] = [];

        const toTheEntity = Effect.map(
          Board.client,
          (clientFor): Answer =>
            (tag, payload, headers) => {
              const answer = clientFor("board")[tag]?.(payload, { headers });

              return Effect.isEffect(answer)
                ? Effect.orDie(answer)
                : Effect.die(new Error(`No unary rpc ${tag}`));
            }
        );

        const received = yield* Effect.gen(function* () {
          const client = yield* ActionRpc.client(signedOut, {
            delivery: "poll",
          });

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
        expect(forwarded.at(-1)).toStrictEqual({
          tag: `${Posted.name}/release`,
        });
      }),
    { timeout: 10_000 }
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
                tag === Posted.name
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
          const client = yield* ActionRpc.client(signedOut, {
            delivery: "poll",
          });

          yield* client
            .watch(Posted, {}, { cursor: "0" })
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
          { tag: Posted.name, cursor: "0", watch: first?.watch },
          { tag: Posted.name, cursor: "0", watch: first?.watch },
        ]);
      })
  );
});
