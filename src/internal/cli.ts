import { Console, Effect, Option, Schema } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import type * as Action from "../Action.js";

/** Options shared by the local and HTTP command projections. */
interface CommonOptions<Output> {
  /** Override the command name. The action name is used by default. */
  readonly name?: string;
  /** Human output. Adds a `--json` flag to the command that selects JSON instead. */
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
  readonly input: (parsed: Command.Command.Config.InferValue<Parameters>) => Schema.Json;
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

/**
 * A command with a renderer takes `--json` as a flag of its own, so nothing is
 * claimed tree-wide and a host's `--json`, global or not, is never contested.
 * Without a renderer the output is JSON already and there is no flag.
 */
const jsonFlag = Flag.Boolean("json").pipe(
  Flag.withDefault(false),
  Flag.withDescription("Print machine-readable JSON"),
);

const output = <A extends Action.Any, E, R>(
  action: A,
  execute: (input: A["input"]["Type"]) => Effect.Effect<A["success"]["Type"], E, R>,
  input: A["input"]["Type"],
  render: ((output: A["success"]["Type"]) => string) | undefined,
) =>
  Effect.gen(function* () {
    const value = yield* execute(input);
    // Validate and encode before rendering, so human output cannot conceal an
    // invalid action success value.
    const encoded = yield* Schema.encodeEffect(Schema.toCodecJson(action.success))(value);

    yield* Console.log(render === undefined ? JSON.stringify(encoded, null, 2) : render(value));
  });

/**
 * One native command. The action's own parameters are one nested config, so the
 * flag added for a renderer never meets them in one record.
 */
const make = <A extends Action.Any, E, R, Config extends Command.Command.Config>(
  action: A,
  execute: (input: A["input"]["Type"]) => Effect.Effect<A["success"]["Type"], E, R>,
  options: CommonOptions<A["success"]["Type"]> | undefined,
  config: Config,
  decode: (
    parsed: Command.Command.Config.InferValue<Config>,
  ) => Effect.Effect<A["input"]["Type"], Schema.SchemaError>,
) => {
  const name = options?.name ?? action.name;
  const render = options?.render;

  const command =
    render === undefined
      ? Command.make(name, { parameters: config }, ({ parameters }) =>
          Effect.flatMap(decode(parameters), (input) => output(action, execute, input, undefined)),
        )
      : Command.make(name, { parameters: config, json: jsonFlag }, ({ parameters, json }) =>
          Effect.flatMap(decode(parameters), (input) =>
            output(action, execute, input, json ? undefined : render),
          ),
        );

  return command.pipe(Command.withDescription(action.description));
};

/**
 * The whole encoded input, inline or from a file. The native parser decodes both,
 * so an invalid value is rendered with the command's help wherever it came from.
 */
const inputFlags = (codec: Action.Codec) => ({
  input: Flag.String("input").pipe(
    Flag.withSchema(Schema.fromJsonString(codec)),
    Flag.optional,
    Flag.withDescription("Whole canonical action input as JSON"),
  ),
  inputFile: Flag.FileSchema("input-file", codec, { format: "json" }).pipe(
    Flag.optional,
    Flag.withDescription("File containing the whole canonical action input as JSON"),
  ),
});

const defaultCommand = <A extends Action.Any, E, R>(
  action: A,
  execute: (input: A["input"]["Type"]) => Effect.Effect<A["success"]["Type"], E, R>,
  options: JsonOptions<A["success"]["Type"]> | undefined,
) => {
  const codec = Schema.toCodecJson(action.input);

  return make(action, execute, options, inputFlags(codec), (parsed) =>
    // A file takes precedence over inline input. Neither decodes `{}` afresh
    // each run, so invocations of one command never share an input value.
    Option.match(
      Option.orElse(parsed.inputFile, () => parsed.input),
      {
        onNone: () => Schema.decodeUnknownEffect(codec)({}),
        onSome: Effect.succeed,
      },
    ),
  );
};

const parametersCommand = <A extends Action.Any, E, R, Parameters extends Command.Command.Config>(
  action: A,
  execute: (input: A["input"]["Type"]) => Effect.Effect<A["success"]["Type"], E, R>,
  options: ParametersOptions<A["success"]["Type"], Parameters>,
) =>
  make(action, execute, options, options.parameters, (parsed) =>
    Schema.decodeUnknownEffect(Schema.toCodecJson(action.input))(options.input(parsed)),
  );

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
