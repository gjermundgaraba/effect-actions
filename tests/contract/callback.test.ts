import { expect, it } from "@effect/vitest";
import { Arbitrary, Option, Schema } from "effect";

import { WebhookSecret } from "../../src/contract/callback.js";

const Key = Schema.Struct({
  length: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 96 })),
  seed: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 255 })),
});

const Edge = Schema.Struct({
  bound: Schema.Literals([24, 64]),
  offset: Schema.Literals([-1, 0, 1]),
  seed: Key.fields.seed,
});

const bytesOf = ({ length, seed }: typeof Key.Type) =>
  Array.from({ length }, (_, index) => (seed + index * 31) % 256);

const decodeSecret = Schema.decodeUnknownOption(WebhookSecret);

it.prop(
  "decodes whsec_ and the base64 of 24 to 64 bytes as those bytes, and refuses any other length, drawn across 0 to 96 and either side of each bound",
  [Arbitrary.schema(Key), Arbitrary.schema(Edge)],
  ([key, { bound, offset, seed }]) => {
    for (const bytes of [
      bytesOf(key),
      bytesOf({ length: bound + offset, seed }),
    ]) {
      const text = `whsec_${Buffer.from(bytes).toString("base64")}`;
      const decoded = decodeSecret(text);

      expect(Option.isSome(decoded)).toBe(
        bytes.length >= 24 && bytes.length <= 64
      );

      if (Option.isSome(decoded)) {
        expect([...decoded.value.key]).toStrictEqual(bytes);
        expect(Schema.encodeSync(WebhookSecret)(decoded.value)).toBe(text);
      }
    }
  }
);

const Unprefixed = Schema.String.check(
  Schema.makeFilter((text) => !text.startsWith("whsec_"))
);

it.prop(
  "refuses a secret without the whsec_ prefix, whatever its key",
  [Arbitrary.schema(Key), Arbitrary.schema(Unprefixed)],
  ([key, prefix]) => {
    expect(
      decodeSecret(`${prefix}${Buffer.from(bytesOf(key)).toString("base64")}`)
    ).toStrictEqual(Option.none());
  }
);
