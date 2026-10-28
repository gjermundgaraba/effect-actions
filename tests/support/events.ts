import * as Action from "@gjermundgaraba/effect-actions/Action";
import * as Event from "@gjermundgaraba/effect-actions/Event";
import { Effect, Match, Schema } from "effect";
import { TestClock } from "effect/testing";

export const settle = TestClock.adjust("0 millis");

export const Posted = Event.make("message.posted", {
  description: "A message was posted.",
  input: {
    channel: Schema.optional(Schema.String).annotate({
      description: "Only this channel.",
    }),
  },
  payload: { id: Schema.String, channel: Schema.String, text: Schema.String },
  caller: Action.Anyone,
});

export type Message = typeof Posted.payload.Type;

export type Received = Event.Received<typeof Posted>;

export const texts = (received: readonly Received[]) =>
  received.map((item) =>
    Match.valueTags(item, {
      Gap: () => "gap",
      Occurrence: ({ data }) => data.text,
    })
  );

export const makeMessages = () => {
  const messages: Message[] = [];
  const reads = new Map<string, number>();
  let checks = 0;

  const post = (channel: string, text: string) =>
    messages.push({ id: `m${messages.length + 1}`, channel, text });

  const check = (
    { channel }: typeof Posted.input.Type,
    cursor: string | null
  ) =>
    Effect.sync(() => {
      checks += 1;
      reads.set(channel ?? "*", (reads.get(channel ?? "*") ?? 0) + 1);

      const seen = cursor === null ? messages.length : Number(cursor);

      return {
        cursor: String(messages.length),
        events: messages
          .slice(seen)
          .flatMap((data) =>
            channel === undefined || data.channel === channel
              ? [{ eventId: data.id, data }]
              : []
          ),
      };
    });

  return {
    post,
    check,
    implementation: Event.implement(Posted, {
      check,
      key: ({ channel }) => channel,
    }),
    checks: () => checks,
    readsOf: (channel: string) => reads.get(channel) ?? 0,
  };
};
