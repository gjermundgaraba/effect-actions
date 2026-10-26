import { expect, it } from "@effect/vitest";
import { Arbitrary, Predicate, Schema } from "effect";
import { canonical } from "../../src/contract/canonical.js";

const Leaf = Schema.Union([Schema.String, Schema.Finite, Schema.Boolean, Schema.Null]);

const Input = Schema.Record(
  Schema.String,
  Schema.Union([Leaf, Schema.Array(Leaf), Schema.Record(Schema.String, Leaf)]),
);

type Input = typeof Input.Type;

const reversed = (value: Input[string]): Input[string] =>
  Predicate.isObject(value) && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).toReversed())
    : value;

it.prop(
  "writes a subscription's encoded input one way whatever the order of its keys, and two inputs that differ two ways",
  [Arbitrary.schema(Input), Arbitrary.schema(Input)],
  ([input, other]) => {
    const reordered = Object.fromEntries(
      Object.entries(input)
        .toReversed()
        .map(([key, value]) => [key, reversed(value)]),
    );

    expect(canonical(reordered)).toBe(canonical(input));
    expect(canonical(other) === canonical(input)).toBe(Schema.toEquivalence(Input)(other, input));
  },
);
