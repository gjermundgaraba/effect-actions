import * as ActionHttp from "@gjermundgaraba/effect-actions/ActionHttp";
import type * as Event from "@gjermundgaraba/effect-actions/Event";
import { Effect, Queue, Stream } from "effect";

import type {
  Heard,
  Hooked,
  Leased,
  Logged,
  Note,
  Pinned,
  Polled,
} from "../board.js";
import { BoardHttp } from "../board.js";

export const boards = ActionHttp.client(BoardHttp, {
  baseUrl: "https://worker.example",
});

type Watched =
  | Event.Received<typeof Pinned>
  | Event.Received<typeof Logged>
  | Event.Received<typeof Heard>
  | Event.Received<typeof Hooked>
  | Event.Received<typeof Leased>
  | Event.Received<typeof Polled>;

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
