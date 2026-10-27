import { Effect, Layer, Schema } from "effect";
import { Rpc, RpcGroup, RpcServer } from "effect/rpc";

export class Expired extends Schema.TaggedError<
  Expired,
  { readonly brand: unique symbol }
>()("Expired", {
  at: Schema.Date,
}) {}

export class Unclonable {
  readonly field = 1;
}

export const Values = Schema.Struct({
  maybe: Schema.UndefinedOr(Schema.String),
  at: Schema.Date,
  bytes: Schema.Uint8Array,
  option: Schema.Option(Schema.Date),
  map: Schema.ReadonlyMap(Schema.String, Schema.Date),
  set: Schema.ReadonlySet(Schema.Finite),
});

export const Instant = Schema.instanceOf(Date);

export const NativeRpcs = RpcGroup.make(
  Rpc.make("echo", { payload: { values: Values }, success: Values }),
  Rpc.make("maybe", {
    payload: { value: Schema.UndefinedOr(Schema.String) },
    success: Schema.UndefinedOr(Schema.String),
  }),
  Rpc.make("expire", { payload: { at: Schema.Date }, error: Expired }),
  Rpc.make("crash", { payload: { message: Schema.String } }),
  Rpc.make("unclonable", { success: Schema.Unknown }),
  Rpc.make("crashUnclonable"),
  Rpc.make("instant", { payload: { at: Instant }, success: Instant }),
  Rpc.make("bytes", {
    payload: { size: Schema.Int },
    success: Schema.Uint8Array,
  }),
  Rpc.make("crashAfter", { payload: { millis: Schema.Int } }),
  Rpc.make("answerAfter", { payload: { millis: Schema.Int } })
);

export const nativeCalls = RpcServer.layer(NativeRpcs).pipe(
  Layer.provide(
    NativeRpcs.toLayer({
      echo: ({ values }) => Effect.succeed(values),
      maybe: ({ value }) => Effect.succeed(value),
      expire: ({ at }) => Effect.fail(new Expired({ at })),
      crash: ({ message }) => Effect.die(new Error(message)),
      unclonable: () => Effect.succeed(new Unclonable()),
      crashUnclonable: () => Effect.die(new Unclonable()),
      instant: ({ at }) => Effect.succeed(at),
      bytes: ({ size }) => Effect.sync(() => new Uint8Array(size)),
      crashAfter: ({ millis }) =>
        Effect.andThen(
          Effect.sleep(millis),
          Effect.die(new Error("late boom"))
        ),
      answerAfter: ({ millis }) => Effect.sleep(millis),
    })
  )
);
