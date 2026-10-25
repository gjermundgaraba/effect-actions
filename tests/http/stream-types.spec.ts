import { Effect, Schema, Stream } from "effect";
import type { HttpClientError } from "effect/http";
import { expectTypeOf } from "@effect/vitest";
import * as Action from "../../src/contract/Action.js";
import * as ActionHttp from "../../src/http/ActionHttp.js";

class LogGone extends Schema.TaggedError<LogGone>()("LogGone", {}, { httpApiStatus: 410 }) {}

const Tail = Action.make("tail", {
  description: "Follow a log.",
  success: Action.Stream({ line: Schema.String }),
  error: LogGone,
  readOnly: true,
  caller: Action.Anyone,
});

const Follow = Action.make("follow", {
  description: "Follow a build, reporting its step.",
  success: Action.Stream(Schema.String),
  progress: { step: Schema.Finite },
  readOnly: true,
  caller: Action.Anyone,
});

const Open = Action.make("open", { description: "", readOnly: true, caller: Action.Anyone });

const Http = ActionHttp.make([Tail, Follow, Open]);

export const tailOverHttp = Effect.gen(function* () {
  const http = yield* ActionHttp.client(Http);
  const tailed = http.tail();

  expectTypeOf<Stream.Success<typeof tailed>>().toEqualTypeOf<{ readonly line: string }>();
  expectTypeOf<Stream.Error<typeof tailed>>().toEqualTypeOf<ActionHttp.MethodError<typeof Tail>>();
  expectTypeOf<
    Extract<Stream.Error<typeof tailed>, { readonly _tag: string }>["_tag"]
  >().toEqualTypeOf<
    | "LogGone"
    | "InvalidInput"
    | "Unauthenticated"
    | "Forbidden"
    | "HttpClientError"
    | "SchemaError"
    | "SseError"
    | "Retry"
  >();
  expectTypeOf<Stream.Services<typeof tailed>>().toBeNever();

  const followed = http.follow({}, { onProgress: ({ step }) => Effect.log(step) });

  expectTypeOf<Stream.Success<typeof followed>>().toEqualTypeOf<string>();
  expectTypeOf<Stream.Error<typeof followed>>().toEqualTypeOf<
    ActionHttp.MethodError<typeof Follow>
  >();

  const opened = http.open();

  expectTypeOf<Effect.Error<typeof opened>>().toEqualTypeOf<
    Action.BuiltIn | HttpClientError.HttpClientError | Schema.SchemaError
  >();
});
