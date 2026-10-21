import { Effect, type Exit, Predicate, Ref, Schedule, Stream } from "effect";
import type { Message } from "./chat/Chat.js";

// A room followed, as a page renders it: `opened` at a subscription's first message, each
// `message`, then `closed` with how following ended: a refusal, or a defect, such as a message
// the page cannot decode, which a page watching only for failures would never see.
export interface Following<E> {
  readonly opened: Effect.Effect<void>;
  readonly message: (message: Message) => Effect.Effect<void>;
  readonly closed: (exit: Exit.Exit<void, E>) => Effect.Effect<void>;
}

// How long a page waits before it subscribes again, longer each time, at most ten seconds.
// `Stream.retry` starts it over once a subscription sends a message, so a page that followed
// for an hour waits a quarter of a second after its next drop, not ten.
const backoff = Schedule.min([Schedule.exponential("250 millis"), Schedule.spaced("10 seconds")]);

// The room's messages after `after`, then each one posted, told to `page`; `watch` is the
// room's subscription from an id. Effect's socket client fails every stream it runs with
// `RpcClientError` when its socket drops, and connects again by itself, so the page subscribes
// again after the backoff, from the last message it holds, until a refusal or a defect ends it.
// A message posted as the page subscribes may arrive twice, so the page drops an id it holds.
export const follow = <E, R>(
  watch: (after: number) => Stream.Stream<Message, E, R>,
  after: number,
  page: Following<E>,
) =>
  Effect.gen(function* () {
    const last = yield* Ref.make(after);

    const subscription = Stream.unwrap(
      Effect.map(Ref.get(last), (from) => watch(from).pipe(Stream.onFirst(() => page.opened))),
    );

    const exit = yield* subscription.pipe(
      Stream.retry(($) =>
        $(backoff).pipe(Schedule.while(({ input }) => Predicate.isTagged(input, "RpcClientError"))),
      ),
      Stream.runForEach((message) =>
        Effect.flatMap(Ref.get(last), (held) =>
          message.id > held
            ? Effect.andThen(Ref.set(last, message.id), page.message(message))
            : Effect.void,
        ),
      ),
      Effect.exit,
    );

    yield* page.closed(exit);
  });
