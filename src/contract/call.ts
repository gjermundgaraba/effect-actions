import { Effect, Predicate, Schema, Stream } from "effect";
import type * as Action from "./Action.js";
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

// Why: A method's arguments are erased at the client's boundary, typed there by `Call`, so the
// options after the input are read by their shape.
const isCallOptions = (options: unknown): options is CallOptions<unknown> =>
  Predicate.hasProperty(options, "onProgress") && Predicate.isFunction(options.onProgress);

/** The `onProgress` a call's arguments give after its input, where they give one. */
export const onProgressOf = (
  args: ReadonlyArray<ErasedValue>,
): CallOptions<unknown>["onProgress"] => {
  const options = args[1];

  return isCallOptions(options) ? options.onProgress : undefined;
};

/**
 * How HTTP, RPC, MCP and a command decode a request's input: reporting every issue, and refusing a
 * field the input does not declare.
 */
export const inputParseOptions = { errors: "all", onExcessProperty: "error" } as const;

/** Decode `action`'s input from its JSON form by `inputParseOptions`, or fail with `InvalidInput`. */
export const decodeInput = (
  action: Pick<Action.Any, "input">,
): ((encoded: ErasedValue) => Effect.Effect<ErasedValue, InvalidInput>) => {
  const decode = Schema.decodeUnknownEffect(Schema.toCodecJson(action.input), inputParseOptions);

  return (encoded) => Effect.mapError(decode(encoded), InvalidInput.fromSchemaError);
};

export const inputOf = (
  action: Pick<Action.Any, "input">,
  args: ReadonlyArray<ErasedValue>,
): Effect.Effect<ErasedValue, Schema.SchemaError> =>
  args.length === 0
    ? Schema.decodeUnknownEffect(Schema.toCodecJson(action.input))({})
    : Effect.succeed(args[0]);

export type ErasedMethod<R = never> = (
  ...input: ReadonlyArray<ErasedValue>
) => Effect.Effect<ErasedValue, unknown, R>;

/**
 * A client's method of `action`, its input checked by encoding it before `send` sends it, given
 * as it is and as its JSON, with the call's `onProgress` where it gave one, taking decoded
 * values, for `send` to use where the action declares `progress`.
 */
export const checked = <R, A = ErasedValue>(
  action: Action.Any,
  send: (
    payload: ErasedValue,
    onProgress: CallOptions<unknown>["onProgress"],
    json: Schema.Json,
  ) => Effect.Effect<A, unknown, R>,
): ((...input: ReadonlyArray<ErasedValue>) => Effect.Effect<A, unknown, R>) => {
  const encode = Schema.encodeUnknownEffect(Schema.toCodecJson(action.input), { errors: "all" });

  return (...args) =>
    inputOf(action, args).pipe(
      Effect.flatMap((payload) => Effect.map(encode(payload), (json) => ({ payload, json }))),
      Effect.mapError(InvalidInput.fromSchemaError),
      Effect.flatMap(({ payload, json }) => send(payload, onProgressOf(args), json)),
    );
};

export type ErasedStreamMethod<R = never> = (
  ...input: ReadonlyArray<ErasedValue>
) => Stream.Stream<ErasedValue, unknown, R>;

/** A client's method of `action` answering a stream, its input checked as `checked` checks it. */
export const checkedStream = <R>(
  action: Action.Any,
  send: (
    payload: ErasedValue,
    onProgress: CallOptions<unknown>["onProgress"],
    json: Schema.Json,
  ) => Stream.Stream<ErasedValue, unknown, R>,
): ErasedStreamMethod<R> => {
  const method = checked(action, (payload, onProgress, json) =>
    Effect.succeed(send(payload, onProgress, json)),
  );

  return (...args) => Stream.unwrap(method(...args));
};
