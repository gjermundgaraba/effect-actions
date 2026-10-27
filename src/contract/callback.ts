import {
  Effect,
  Option,
  Schema,
  SchemaIssue,
  SchemaTransformation,
} from "effect";

/** A webhook's callback: an https URL, which each delivery is POSTed to, decoded as a `URL`. */
export const CallbackUrl = Schema.String.annotate({
  description: "The https URL each delivery is POSTed to.",
}).pipe(
  Schema.decodeTo(Schema.URL, SchemaTransformation.urlFromString),
  Schema.check(
    Schema.makeFilter((url) => url.protocol === "https:" || "an https URL")
  )
);

/** A Standard Webhooks signing secret: as written, `whsec_` and base64, and the key it holds. */
export const SigningSecret = Schema.Struct({
  text: Schema.String,
  key: Schema.Uint8Array,
});

export type SigningSecret = typeof SigningSecret.Type;

const secretPrefix = "whsec_";

const decodeBase64 = Schema.decodeUnknownOption(Schema.Uint8ArrayFromBase64);

const keyOf = (text: string): Option.Option<Uint8Array> =>
  text.startsWith(secretPrefix)
    ? Option.filter(
        decodeBase64(text.slice(secretPrefix.length)),
        (key) => key.length >= 24 && key.length <= 64
      )
    : Option.none();

/**
 * A webhook's signing secret, as Standard Webhooks writes one: `whsec_` and the base64 of 24 to
 * 64 bytes, decoded as the `SigningSecret` it is.
 */
export const WebhookSecret = Schema.String.annotate({
  description:
    "whsec_ and the base64 of 24 to 64 random bytes, which signs each delivery.",
}).pipe(
  Schema.decodeTo(
    SigningSecret,
    SchemaTransformation.transformEffect({
      decode: (text, options) =>
        Option.match(keyOf(text), {
          onNone: () =>
            Effect.fail(
              new SchemaIssue.InvalidValue(
                { message: "whsec_ and the base64 of 24 to 64 random bytes" },
                text,
                options
              )
            ),
          onSome: (key) => Effect.succeed({ text, key }),
        }),
      encode: ({ text }) => Effect.succeed(text),
    })
  )
);
