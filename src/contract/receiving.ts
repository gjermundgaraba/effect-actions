import { Context, Effect, Option, Schema, type Scope, Struct } from "effect";
import type { SigningSecret } from "./callback.js";
import { reasonOf, refusalOf } from "./codes.js";
import { Forbidden, type Refusal } from "./errors.js";
import type * as Event from "./Event.js";
import { Gap, untaggedOccurrenceOf } from "./occurrence.js";
import type { Fed } from "./pages.js";

/** A POST a receiver verified, its JSON body: an occurrence, or an envelope. */
export type Delivered = { readonly [key: string]: Schema.Json };

/** The query parameter of a watch's delivery URL naming its place at the receiver. */
export const watchParameter = "watch";

/**
 * One watch's place at a receiver: the id its delivery URL names in `watchParameter`, and the
 * secret to subscribe with.
 */
export interface Registered {
  readonly id: string;
  readonly secret: SigningSecret;
}

/**
 * Where a watch by webhook receives its deliveries in this process: `Webhook.layerReceiver`
 * provides it beside its route at `path`, and `register` keeps a watch's place for its scope,
 * handing each verified body to `deliver`, which answers `false` while the watch has no room
 * for it.
 */
export class Receiving extends Context.Service<
  Receiving,
  {
    readonly path: `/${string}`;
    readonly register: (
      deliver: (body: Delivered) => boolean,
    ) => Effect.Effect<Registered, never, Scope.Scope>;
  }
>()("effect-actions/Receiving") {}

const Terminated = Schema.Struct({
  error: Schema.Struct({
    code: Schema.optional(Schema.Int),
    message: Schema.String,
    data: Schema.optional(Schema.Json),
  }),
});

const decodeTerminated = Schema.decodeUnknownOption(Terminated);

const decodeGap = Schema.decodeUnknownEffect(
  Schema.toCodecJson(Gap.mapFields(Struct.omit(["_tag"]))),
);

const ended = new Forbidden({ message: "The subscription was ended." });

/**
 * What a watch of `event` reads from one delivered body: its occurrence, or the gap an envelope
 * reports; a `terminated` envelope fails with the reason its error's code names, its refusal for
 * any other, an envelope of another type is skipped, and a body that does not decode fails with a
 * `SchemaError`.
 */
export const webhookFed = (event: Event.Any) => {
  const occurrenceOf = untaggedOccurrenceOf(event);

  return (
    body: Delivered,
  ): Effect.Effect<ReadonlyArray<Fed>, Event.SubscriptionError | Refusal | Schema.SchemaError> => {
    switch (body["type"]) {
      case undefined:
        return Effect.map(occurrenceOf(body), (occurrence) => [occurrence]);
      case "gap":
        return Effect.map(decodeGap(body), (fields) => [Gap.make(fields)]);
      case "terminated":
        return Effect.fail(
          Option.match(decodeTerminated(body), {
            onNone: () => ended,
            onSome: ({ error }) => reasonOf(event.name, error) ?? refusalOf(error),
          }),
        );
      default:
        return Effect.succeed([]);
    }
  };
};
