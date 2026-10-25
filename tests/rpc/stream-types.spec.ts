import { Effect, Schema, Stream } from "effect";
import type { RpcClientError } from "effect/rpc";
import { expectTypeOf } from "@effect/vitest";
import * as Action from "../../src/contract/Action.js";
import * as ActionRpc from "../../src/rpc/ActionRpc.js";

class LogGone extends Schema.TaggedError<LogGone>()("LogGone", {}) {}

const Tail = Action.make("tail", {
  description: "Follow a log, reporting how far it is read.",
  success: Action.Stream({ line: Schema.String }),
  progress: { read: Schema.Finite },
  error: LogGone,
  readOnly: true,
  caller: Action.Anyone,
});

const Lines = Action.make("lines", {
  description: "Stream lines.",
  success: Action.Stream(Schema.String),
  readOnly: true,
  caller: Action.Anyone,
});

const Rpc = ActionRpc.make([Tail, Lines]);

export const tailOverRpc = Effect.gen(function* () {
  const rpc = yield* ActionRpc.client(Rpc);
  const tailed = rpc.tail({}, { onProgress: ({ read }) => Effect.log(read) });

  expectTypeOf<Stream.Success<typeof tailed>>().toEqualTypeOf<{ readonly line: string }>();
  expectTypeOf<Stream.Error<typeof tailed>>().toEqualTypeOf<
    LogGone | Action.BuiltIn | RpcClientError.RpcClientError
  >();
  expectTypeOf<Stream.Services<typeof tailed>>().toBeNever();

  const lines = rpc.lines();

  expectTypeOf<Stream.Success<typeof lines>>().toEqualTypeOf<string>();
  expectTypeOf<Stream.Error<typeof lines>>().toEqualTypeOf<
    Action.BuiltIn | RpcClientError.RpcClientError
  >();
});
