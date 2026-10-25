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

/**
 * Values of `schema` as they cross a network: each encoded to its JSON, then decoded back from
 * that JSON's text, which carries `-0` as `0`, every issue reported, answering the JSON sent and
 * the value received.
 */
export const jsonRoundTrip = <S extends Codec>(schema: S) => {
  const codec = Schema.toCodecJson(schema);
  const encode = Schema.encodeUnknownEffect(codec, { errors: "all" });
  const decode = Schema.decodeUnknownEffect(Schema.fromJsonString(codec), { errors: "all" });

  return (
    value: S["Type"],
  ): Effect.Effect<{ readonly json: Schema.Json; readonly value: S["Type"] }, Schema.SchemaError> =>
    Effect.flatMap(encode(value), (json) =>
      Effect.map(decode(JSON.stringify(json)), (received) => ({ json, value: received })),
    );
};

/**
 * A watch's input as every client sends it: read as `inputOf` reads an action's, then through
 * its JSON, dropping undeclared fields, or `InvalidInput` reporting every issue.
 */
export const watchInput = (
  event: Pick<Action.Any, "input">,
  input: ErasedValue,
): Effect.Effect<{ readonly json: Schema.Json; readonly value: ErasedValue }, InvalidInput> =>
  inputOf(event, input === undefined ? [] : [input]).pipe(
    Effect.flatMap(jsonRoundTrip(event.input)),
    Effect.mapError(InvalidInput.fromSchemaError),
  );

export type ErasedMethod<R = never> = (
  ...input: ReadonlyArray<ErasedValue>
) => Effect.Effect<ErasedValue, unknown, R>;

/**
 * How a client checks a call's input before sending it, chosen once per client: what it sends of
 * an input whose JSON encodes by `action`'s schema, or the `SchemaError` of one that does not.
 */
export type CheckedInput<S> = (
  action: Pick<Action.Any, "input">,
) => (input: ErasedValue) => Effect.Effect<S, Schema.SchemaError>;

/** Send the input's JSON, for a client handing it to its protocol as it is. */
export const sendingJson: CheckedInput<Schema.Json> = (action) =>
  Schema.encodeUnknownEffect(Schema.toCodecJson(action.input), { errors: "all" });

/** Send the input itself once its JSON encodes, for a client encoding it by the action's schema. */
export const sendingValue: CheckedInput<ErasedValue> = (action) => {
  const encode = sendingJson(action);

  return (input) => Effect.as(encode(input), input);
};

/**
 * A client's method of `action`, its input checked by `check` before `send` sends what the check
 * answers, with the call's `onProgress` where it gave one, taking decoded values, for `send` to
 * use where the action declares `progress`.
 */
export const checked = <S, R, A = ErasedValue>(
  action: Action.Any,
  check: CheckedInput<S>,
  send: (input: S, onProgress: CallOptions<unknown>["onProgress"]) => Effect.Effect<A, unknown, R>,
): ((...input: ReadonlyArray<ErasedValue>) => Effect.Effect<A, unknown, R>) => {
  const encode = check(action);

  return (...args) =>
    inputOf(action, args).pipe(
      Effect.flatMap(encode),
      Effect.mapError(InvalidInput.fromSchemaError),
      Effect.flatMap((input) => send(input, onProgressOf(args))),
    );
};

export type ErasedStreamMethod<R = never> = (
  ...input: ReadonlyArray<ErasedValue>
) => Stream.Stream<ErasedValue, unknown, R>;

/** A client's method of `action` answering a stream, its input checked as `checked` checks it. */
export const checkedStream = <S, R>(
  action: Action.Any,
  check: CheckedInput<S>,
  send: (
    input: S,
    onProgress: CallOptions<unknown>["onProgress"],
  ) => Stream.Stream<ErasedValue, unknown, R>,
): ErasedStreamMethod<R> => {
  const method = checked(action, check, (input, onProgress) =>
    Effect.succeed(send(input, onProgress)),
  );

  return (...args) => Stream.unwrap(method(...args));
};
