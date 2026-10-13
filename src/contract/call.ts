import { Effect, Schema } from "effect";
import type * as Action from "./Action.js";
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
 * How HTTP, RPC and a command decode a request's input: reporting every issue, and refusing a
 * field the input does not declare.
 */
export const inputParseOptions = { errors: "all", onExcessProperty: "error" } as const;

/** Decode `action`'s input from its JSON form by `inputParseOptions`, or fail with `InvalidInput`. */
export const decodeInput = (
  action: Action.Any,
): ((encoded: ErasedValue) => Effect.Effect<ErasedValue, InvalidInput>) => {
  const decode = Schema.decodeUnknownEffect(Schema.toCodecJson(action.input), inputParseOptions);

  return (encoded) => Effect.mapError(decode(encoded), InvalidInput.fromSchemaError);
};

export const inputOf = (
  action: Action.Any,
  args: ReadonlyArray<ErasedValue>,
): Effect.Effect<ErasedValue, Schema.SchemaError> =>
  args.length === 0
    ? Schema.decodeUnknownEffect(Schema.toCodecJson(action.input))({})
    : Effect.succeed(args[0]);

export type ErasedMethod = (
  ...input: ReadonlyArray<ErasedValue>
) => Effect.Effect<ErasedValue, unknown>;

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
