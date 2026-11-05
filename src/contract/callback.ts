import {
  Effect,
  Option,
  Schema,
  SchemaIssue,
  SchemaTransformation,
} from "effect";
import { Base64 } from "effect/encoding";

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

export const signingSecretOf = (key: Uint8Array): SigningSecret => ({
  text: `${secretPrefix}${Base64.encode(key)}`,
  key,
});

const decodeBase64 = Schema.decodeUnknownOption(Schema.Uint8ArrayFromBase64);

const keyOf = (text: string): Option.Option<Uint8Array> =>
  text.startsWith(secretPrefix)
    ? Option.filter(
        decodeBase64(text.slice(secretPrefix.length)),
        (key) => key.length >= 24 && key.length <= 64
      )
    : Option.none();

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
