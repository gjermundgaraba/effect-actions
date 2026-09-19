import { Console, Effect, Option, Schema } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import type * as Action from "../Action.js";

/** Options shared by the local and HTTP command projections. */
interface CommonOptions<Output> {
  /** Override the command name. The action name is used by default. */
  readonly name?: string;
  /** Human output. JSON remains available with `--json`. */
  readonly render?: (output: Output) => string;
}

/** The default projection accepts a whole canonical JSON input with `--input`. */
export interface JsonOptions<Output> extends CommonOptions<Output> {
  readonly parameters?: never;
  readonly input?: never;
}

/** Supply native CLI parameters and map their parsed values to canonical action JSON. */
export interface ParametersOptions<
  Output,
  Parameters extends Command.Command.Config,
> extends CommonOptions<Output> {
  /** Native Effect CLI flags and arguments. */
  readonly parameters: Parameters;
  /** Maps native parsed parameters to the action's canonical JSON input. */
  readonly input: (parsed: Command.Command.Config.Infer<Parameters>) => Schema.Json;
}

/**
 * A command either accepts whole JSON input or has explicit native CLI parameters.
 * The latter intentionally has no implicit `--input` mode.
 */
export type Options<Output, Parameters extends Command.Command.Config = never> =
  | JsonOptions<Output>
  | ParametersOptions<Output, Parameters>;

const isParametersOptions = <Output, Parameters extends Command.Command.Config>(
  options: Options<Output, Parameters> | undefined,
): options is ParametersOptions<Output, Parameters> => options?.parameters !== undefined;

const jsonOutput = Flag.Boolean("json").pipe(
  Flag.optional,
  Flag.withDescription("Print machine-readable JSON"),
);

const output = <A extends Action.Any, E, R>(
  action: A,
  execute: (input: A["input"]["Type"]) => Effect.Effect<A["success"]["Type"], E, R>,
  input: A["input"]["Type"],
  render: ((output: A["success"]["Type"]) => string) | undefined,
  useJson: boolean,
) =>
  Effect.gen(function* () {
    const value = yield* execute(input);
    // Validate and encode before rendering, so human output cannot conceal an
    // invalid action success value.
    const encoded = yield* Schema.encodeEffect(Schema.toCodecJson(action.success))(value);

    const text =
      render !== undefined && !useJson ? render(value) : JSON.stringify(encoded, null, 2);

    yield* Console.log(text);
  });

const defaultCommand = <A extends Action.Any, E, R>(
  action: A,
  execute: (input: A["input"]["Type"]) => Effect.Effect<A["success"]["Type"], E, R>,
  options: JsonOptions<A["success"]["Type"]> | undefined,
) => {
  const input = Flag.String("input").pipe(
    Flag.withDefault("{}"),
    Flag.withSchema(Schema.fromJsonString(Schema.toCodecJson(action.input))),
    Flag.withDescription("Whole canonical action input as JSON"),
  );

  const config =
    options?.render === undefined ? { input } : { input, output: { json: jsonOutput } };

  return Command.make(options?.name ?? action.name, config, (parsed) =>
    Effect.gen(function* () {
      const useJson =
        "output" in parsed &&
        Option.isSome(parsed.output.json) &&
        parsed.output.json.value === true;

      return yield* output(action, execute, parsed.input, options?.render, useJson);
    }),
  ).pipe(Command.withDescription(action.description));
};

const parametersCommand = <A extends Action.Any, E, R, Parameters extends Command.Command.Config>(
  action: A,
  execute: (input: A["input"]["Type"]) => Effect.Effect<A["success"]["Type"], E, R>,
  options: ParametersOptions<A["success"]["Type"], Parameters>,
) => {
  if (options.render === undefined) {
    return Command.make(options.name ?? action.name, options.parameters, (parsed) =>
      Effect.flatMap(
        Schema.decodeUnknownEffect(Schema.toCodecJson(action.input))(options.input(parsed)),
        (input) => output(action, execute, input, undefined, true),
      ),
    ).pipe(Command.withDescription(action.description));
  }

  // Nesting preserves the caller's config verbatim. The native parser detects
  // duplicate flags (including aliases) between it and this output switch.
  return Command.make(
    options.name ?? action.name,
    { parameters: options.parameters, output: { json: jsonOutput } },
    (parsed) =>
      Effect.flatMap(
        Schema.decodeUnknownEffect(Schema.toCodecJson(action.input))(
          options.input(
            // SAFETY: native nested Config inference is the same value shape as
            // Config.Infer<Parameters>; its generic definition cannot express that equality.
            // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Exact native Config inference boundary.
            parsed.parameters as Command.Command.Config.Infer<Parameters>,
          ),
        ),
        (input) =>
          output(
            action,
            execute,
            input,
            options.render,
            Option.isSome(parsed.output.json) && parsed.output.json.value === true,
          ),
      ),
  ).pipe(Command.withDescription(action.description));
};

/** Build one native command around an action-bound operation. */
export const command = <
  A extends Action.Any,
  E,
  R,
  Parameters extends Command.Command.Config = never,
>(
  action: A,
  execute: (input: A["input"]["Type"]) => Effect.Effect<A["success"]["Type"], E, R>,
  options?: Options<A["success"]["Type"], Parameters>,
): Command.Command<string, never, {}, E | Schema.SchemaError, R> => {
  if (isParametersOptions(options)) {
    return parametersCommand(action, execute, options);
  }

  return defaultCommand(action, execute, options);
};
