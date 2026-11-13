import * as ActionHttp from "@gjermundgaraba/effect-actions/ActionHttp";
import type * as Event from "@gjermundgaraba/effect-actions/Event";
import { exports } from "cloudflare:workers";
import { Effect, Layer, Queue, Stream } from "effect";
import { FetchHttpClient } from "effect/http";

import type { Heard, Hooked, Logged, Note, Pinned } from "../board.js";
import { BoardHttp } from "../board.js";

export const throughWorker = FetchHttpClient.layer.pipe(
  Layer.provide(
    Layer.succeed(FetchHttpClient.Fetch)(
      async (input, init) =>
        await exports.default.fetch(new Request(input, init))
    )
  )
);

export const boards = ActionHttp.client(BoardHttp, {
  baseUrl: "https://worker.example",
});

type Watched =
  | Event.Received<typeof Pinned>
  | Event.Received<typeof Logged>
  | Event.Received<typeof Heard>
  | Event.Received<typeof Hooked>;

export const following = (stream: Stream.Stream<Watched, unknown>) =>
  Effect.gen(function* () {
    const received = yield* Queue.unbounded<typeof Note.Type>();

    yield* stream.pipe(
      Stream.runForEach((item) =>
        item._tag === "Occurrence"
          ? Queue.offer(received, item.data)
          : Effect.void
      ),
      Effect.forkScoped
    );

    return received;
  });

export const notes = (received: Queue.Queue<typeof Note.Type>, count: number) =>
  Effect.forEach(Array.from({ length: count }), () =>
    Queue.take(received)
  ).pipe(Effect.timeout("20 seconds"));
