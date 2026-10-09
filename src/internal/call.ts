import { Effect, Schema } from "effect";
import type * as Action from "../Action.js";
import { InvalidInput } from "./errors.js";
import type { ErasedValue } from "./implementation.js";

/**
 * A call of `A` answering `R`. It may leave its input out when `{}` is a valid encoded input,
 * such as for an action declared without `input` or one whose every field has a decoding
 * default, and then sends the input `{}` decodes to. Every client shares this rule:
 * `ActionHttp.client`, `ActionRpc.client`, `Testing.mcpClient` and `Action.client`.
 */
export type Call<A extends Action.Any, R> = {} extends A["input"]["Encoded"]
  ? (...input: [] | [input: A["input"]["Type"]]) => R
  : (input: A["input"]["Type"]) => R;

/**
 * The input a method of `action` sends for the arguments it was called with: a given
 * argument as given, and none as the input `{}` decodes to, as a server decodes the `{}` it
 * receives. `Call` allows none only when `{}` is a valid encoded input, which is what this
 * decodes; decoding makes it one of the input's own values, such as an instance of an input
 * class, or fills its defaults.
 */
export const inputOf = (
  action: Action.Any,
  args: ReadonlyArray<ErasedValue>,
): Effect.Effect<ErasedValue, Schema.SchemaError> =>
  args.length === 0
    ? Schema.decodeUnknownEffect(Schema.toCodecJson(action.input))({})
    : Effect.succeed(args[0]);

/** A remote client's method, erased: the binding's actions restore its exact type. */
export type ErasedMethod = (
  ...input: ReadonlyArray<ErasedValue>
) => Effect.Effect<ErasedValue, unknown>;

/**
 * A remote client's method of `action`, sending its input with `send`, the native client's
 * own. The input is checked as every surface checks it, each issue reported, before the native
 * client encodes it, so it fails as `InvalidInput` rather than as the native client's encoding
 * failure, and nothing is sent.
 */
export const checked = (
  action: Action.Any,
  send: (payload: ErasedValue) => Effect.Effect<ErasedValue, unknown>,
): ErasedMethod => {
  const encode = Schema.encodeUnknownEffect(Schema.toCodecJson(action.input), { errors: "all" });

  return (...args) =>
    inputOf(action, args).pipe(
      Effect.tap(encode),
      Effect.mapError(InvalidInput.fromSchemaError),
      Effect.flatMap(send),
    );
};
