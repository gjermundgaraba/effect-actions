import { Effect, Schema } from "effect";
import { expectTypeOf } from "@effect/vitest";
import * as Action from "../../src/contract/Action.js";

const fields = {
  text: Schema.String,
  count: Schema.Int,
  request: Schema.optional(Schema.String),
};

const Post = Action.make("post", {
  description: "Post a message.",
  input: fields,
  readOnly: false,
  caller: Action.Anyone,
  idempotencyKey: "request",
});

const Plain = Action.make("plain", {
  description: "Post a message, with no key.",
  input: fields,
  readOnly: false,
  caller: Action.Anyone,
});

expectTypeOf(Post.idempotencyKey).toEqualTypeOf<"request">();

expectTypeOf(Plain.idempotencyKey).toEqualTypeOf<undefined>();

const keyed = Action.implement(Post, () => Effect.void);

const plain = Action.implement(Plain, () => Effect.void);

const both = Action.implement([Post, Plain], { post: () => Effect.void, plain: () => Effect.void });

expectTypeOf<Action.BuildServices<typeof keyed>>().toEqualTypeOf<Action.Idempotency>();

expectTypeOf<Action.BuildServices<typeof plain>>().toEqualTypeOf<never>();

expectTypeOf<Action.BuildServices<typeof both>>().toEqualTypeOf<Action.Idempotency>();

Action.make("post", {
  description: "Post a message.",
  input: fields,
  readOnly: false,
  caller: Action.Anyone,
  // @ts-expect-error -- the field is an integer, not a string
  idempotencyKey: "count",
});

Action.make("post", {
  description: "Post a message.",
  input: fields,
  readOnly: false,
  caller: Action.Anyone,
  // @ts-expect-error -- the input has no such field
  idempotencyKey: "missing",
});
