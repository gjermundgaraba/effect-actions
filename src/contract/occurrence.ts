import { Effect, Schema, Struct } from "effect";

import type * as Event from "./Event.js";

/**
 * Occurrences were missed: the cursor resumed from was no longer served, or delivery skipped
 * some. `cursor` is where delivery continues.
 */
export const Gap = Schema.TaggedStruct("Gap", {
  cursor: Schema.NullOr(Schema.String),
});

/** A gap in what a subscriber received. */
export type Gap = typeof Gap.Type;

/**
 * Where a feed has read up to without an occurrence to show for it, such as a quiet page or an
 * occurrence a subscriber's `match` rejected: a watch keeps it as its cursor and never yields it.
 */
export const Checked = Schema.TaggedStruct("Checked", {
  cursor: Schema.NullOr(Schema.String),
});

export type Checked = typeof Checked.Type;

const fieldsOf = <Name extends Schema.Top, Data extends Schema.Top>(
  name: Name,
  data: Data
) => ({
  eventId: Schema.String.annotate({
    description:
      "The source's id for it, or one generated: a subscriber deduplicates by it.",
  }),
  name,
  timestamp: Schema.DateTimeUtc,
  data,
  cursor: Schema.NullOr(Schema.String).annotate({
    description:
      "Where to resume after it, null for an event type that cannot be resumed.",
  }),
});

/** The schema of an occurrence of `E`. */
export type OccurrenceSchema<E extends Event.Any> = Schema.TaggedStruct<
  "Occurrence",
  ReturnType<typeof fieldsOf<Schema.Literal<E["name"]>, E["payload"]>>
>;

export const OccurrenceOf = <E extends Event.Any>(
  event: E
): OccurrenceSchema<E> =>
  Schema.TaggedStruct(
    "Occurrence",
    fieldsOf(Schema.Literal(event.name), event.payload)
  );

export const AnyOccurrence = Schema.TaggedStruct(
  "Occurrence",
  fieldsOf(Schema.String, Schema.Unknown)
);

export const ReceivedOf = <E extends Event.Any>(event: E) =>
  Schema.Union([OccurrenceOf(event), Gap]);

const untaggedOf = (event: Event.Any) =>
  OccurrenceOf(event).mapFields((fields) => ({
    ...Struct.omit(fields, ["_tag"]),
    timestamp: Schema.DateTimeUtcFromString,
    data: Schema.toCodecJson(event.payload),
  }));

export const untaggedOccurrenceOf = (event: Event.Any) => {
  const occurrence = OccurrenceOf(event);
  const decode = Schema.decodeUnknownEffect(untaggedOf(event));

  return (wire: { readonly [key: string]: Schema.Json }) =>
    Effect.map(decode(wire), (fields) => occurrence.make(fields));
};

export const encodeUntaggedOf = (event: Event.Any) => {
  const encode = Schema.encodeEffect(untaggedOf(event));

  return (occurrence: Event.Occurrence<Event.Any>) =>
    Effect.orDie(encode(occurrence));
};
