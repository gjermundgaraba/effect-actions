import { Effect, Predicate, Schema, Stream } from "effect";

import type * as Action from "./Action.js";
import type { Codec } from "./codec.js";
import { InvalidInput } from "./errors.js";
import type { ErasedValue } from "./implementation.js";
import type { CallOptions, ProgressArgs } from "./progress.js";

/**
 * A call of `A` answering `R`, taking `{ onProgress }` after its input where `A` declares
 * `progress`. It may leave its input out when `{}` is a valid encoded input, such as for an
 * action declared without `input` or one whose every field has a decoding default, and then
 * sends the input `{}` decodes to. Every client shares this rule: `ActionHttp.client`,
 * `ActionRpc.client`, `ActionMcp.client` and `Action.client`.
 */
export type Call<A extends Action.Any, R> = {} extends A["input"]["Encoded"]
  ? (...input: [] | [input: A["input"]["Type"], ...ProgressArgs<A>]) => R
  : (input: A["input"]["Type"], ...options: ProgressArgs<A>) => R;

const isCallOptions = (options: ErasedValue): options is CallOptions<unknown> =>
  Predicate.hasProperty(options, "onProgress") &&
  Predicate.isFunction(options.onProgress);

export const onProgressOf = (
  args: readonly ErasedValue[]
): CallOptions<unknown>["onProgress"] => {
  const [, options] = args;

  return isCallOptions(options) ? options.onProgress : undefined;
};

export const inputParseOptions = {
  errors: "all",
  onExcessProperty: "error",
} as const;

export const decodeInput = (
  action: Pick<Action.Any, "input">
): ((encoded: ErasedValue) => Effect.Effect<ErasedValue, InvalidInput>) => {
  const decode = Schema.decodeUnknownEffect(
    Schema.toCodecJson(action.input),
    inputParseOptions
  );

  return (encoded) =>
    Effect.mapError(decode(encoded), InvalidInput.fromSchemaError);
};

export const inputOf = (
  action: Pick<Action.Any, "input">,
  args: readonly ErasedValue[]
): Effect.Effect<ErasedValue, Schema.SchemaError> =>
  args.length === 0
    ? Schema.decodeEffect(Schema.toCodecJson(action.input))({})
    : Effect.succeed(args[0]);

export const jsonRoundTrip = <S extends Codec>(schema: S) => {
  const codec = Schema.toCodecJson(schema);
  const encode = Schema.encodeUnknownEffect(codec, { errors: "all" });

  const decode = Schema.decodeUnknownEffect(Schema.fromJsonString(codec), {
    errors: "all",
  });

  return (
    value: S["Type"]
  ): Effect.Effect<
    { readonly json: Schema.Json; readonly value: S["Type"] },
    Schema.SchemaError
  > =>
    Effect.flatMap(encode(value), (json) =>
      Effect.map(decode(JSON.stringify(json)), (received) => ({
        json,
        value: received,
      }))
    );
};

export const watchInput = (
  event: Pick<Action.Any, "input">,
  input: ErasedValue
): Effect.Effect<
  { readonly json: Schema.Json; readonly value: ErasedValue },
  InvalidInput
> =>
  inputOf(event, input === undefined ? [] : [input]).pipe(
    Effect.flatMap(jsonRoundTrip(event.input)),
    Effect.mapError(InvalidInput.fromSchemaError)
  );

export type ErasedMethod<R = never> = (
  ...input: readonly ErasedValue[]
) => Effect.Effect<ErasedValue, unknown, R>;

export type CheckedInput<S> = (
  action: Pick<Action.Any, "input">
) => (input: ErasedValue) => Effect.Effect<S, Schema.SchemaError>;

export const sendingJson: CheckedInput<Schema.Json> = (action) =>
  Schema.encodeUnknownEffect(Schema.toCodecJson(action.input), {
    errors: "all",
  });

export const sendingValue: CheckedInput<ErasedValue> = (action) => {
  const encode = sendingJson(action);

  return (input) => Effect.as(encode(input), input);
};

export const checked = <S, R, A = ErasedValue>(
  action: Action.Any,
  check: CheckedInput<S>,
  send: (
    input: S,
    onProgress: CallOptions<unknown>["onProgress"]
  ) => Effect.Effect<A, unknown, R>
): ((...input: readonly ErasedValue[]) => Effect.Effect<A, unknown, R>) => {
  const encode = check(action);

  return (...args) =>
    inputOf(action, args).pipe(
      Effect.flatMap(encode),
      Effect.mapError(InvalidInput.fromSchemaError),
      Effect.flatMap((input) => send(input, onProgressOf(args)))
    );
};

export type ErasedStreamMethod<R = never> = (
  ...input: readonly ErasedValue[]
) => Stream.Stream<ErasedValue, unknown, R>;

export const checkedStream = <S, R>(
  action: Action.Any,
  check: CheckedInput<S>,
  send: (
    input: S,
    onProgress: CallOptions<unknown>["onProgress"]
  ) => Stream.Stream<ErasedValue, unknown, R>
): ErasedStreamMethod<R> => {
  const method = checked(action, check, (input, onProgress) =>
    Effect.succeed(send(input, onProgress))
  );

  return (...args) => Stream.unwrap(method(...args));
};
