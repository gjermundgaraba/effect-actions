import { Console, Effect, Option, Predicate, Schema, SchemaAST } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import type * as Action from "../Action.js";
import { assertDistinct } from "./actions.js";

/** How one command is named and prints its result. */
export interface Options<Output> {
  /** Override the command name. The action name, in kebab case, is used by default. */
  readonly name?: string;
  /** Human output. Adds a `--json` flag to the command that selects JSON instead. */
  readonly render?: (output: Output) => string;
}

/** `getUser` as a command or flag name: `get-user`. */
export const kebab = (name: string): string =>
  name
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/_/g, "-")
    .toLowerCase();

/**
 * A command with a renderer takes `--json` as a flag of its own, so nothing is
 * claimed tree-wide and a host's `--json`, global or not, is never contested.
 * Without a renderer the output is JSON already and there is no flag.
 */
const jsonFlag = Flag.Boolean("json").pipe(
  Flag.withDefault(false),
  Flag.withDescription("Print machine-readable JSON"),
);

/** Flags the native parser claims on every command. */
const builtInFlags = ["help", "version", "wizard", "completions", "log-level"];

/** Any JSON value, as one flag's text. */
const jsonValue = Schema.fromJsonString(Schema.Json);

/** The strings a union of string literals accepts, if it is one. */
const choices = (ast: SchemaAST.AST): ReadonlyArray<string> | undefined => {
  const members = SchemaAST.isUnion(ast) ? ast.types : [ast];

  const literals = members.flatMap((member) =>
    SchemaAST.isLiteral(member) && Predicate.isString(member.literal) ? [member.literal] : [],
  );

  return literals.length === members.length ? literals : undefined;
};

/**
 * The native flag parsing one field's encoded JSON value: a string, number or boolean
 * flag for those, a choice for string literals, and a JSON flag for anything else.
 */
const valueFlag = (name: string, encoded: SchemaAST.AST): Flag.Flag<unknown> => {
  const literals = choices(encoded);

  if (literals !== undefined) return Flag.Literals(name, literals);

  if (SchemaAST.isString(encoded)) return Flag.String(name);

  if (SchemaAST.isNumber(encoded)) return Flag.Finite(name);

  if (SchemaAST.isBoolean(encoded)) return Flag.Boolean(name);

  return Flag.String(name).pipe(Flag.withSchema(jsonValue), Flag.withMetavar("json"));
};

/**
 * A field's flag, `None` when omitted. A required boolean is a switch: omitted, it is
 * `false`, as a switch reads.
 */
const fieldFlag = (name: string, encoded: SchemaAST.AST): Flag.Flag<Option.Option<unknown>> =>
  SchemaAST.isBoolean(encoded) && !SchemaAST.isOptional(encoded)
    ? Flag.Boolean(name).pipe(Flag.withDefault(false), Flag.map(Option.some))
    : Flag.optional(valueFlag(name, encoded));

/** One flag per input field, parsed as the field's encoded value, `None` when omitted. */
type FieldFlags = Readonly<Record<string, Flag.Flag<Option.Option<unknown>>>>;

/** What `FieldFlags` parse to, by field. */
type Parsed = Readonly<Record<string, Option.Option<unknown>>>;

/**
 * One flag per top-level field of a struct input, named after the field in kebab case.
 * Every flag is optional to the parser: the action's schema decides what is required, so
 * a missing field is reported exactly as any other invalid input.
 */
const fieldFlags = (input: SchemaAST.Objects, encoded: SchemaAST.Objects): FieldFlags => {
  const flags = encoded.propertySignatures.map((property) => {
    const key = String(property.name);
    const described = input.propertySignatures.find((field) => field.name === property.name);

    const description =
      described === undefined ? undefined : SchemaAST.resolveDescription(described.type);

    const flag = fieldFlag(kebab(key), property.type);

    return [
      key,
      description === undefined ? flag : Flag.withDescription(flag, description),
    ] as const;
  });

  assertDistinct(
    "flag",
    flags.map(([key]) => kebab(key)),
  );

  return Object.fromEntries(flags);
};

/** The encoded input the parsed flags stand for: every given field, and no other. */
const fromFields = (parsed: Parsed) =>
  Object.fromEntries(
    Object.entries(parsed).flatMap(([key, value]) =>
      Option.toArray(Option.map(value, (v) => [key, v] as const)),
    ),
  );

/** The whole encoded input as JSON, for an input that is not a struct of fields. */
const inputFlag = Flag.String("input").pipe(
  Flag.withSchema(jsonValue),
  Flag.optional,
  Flag.withDescription("Whole action input as JSON"),
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

/** An action's input as native flags, and how to decode what they parse. */
interface InputConfig<A extends Action.Any> {
  readonly config: FieldFlags;
  readonly decode: (parsed: Parsed) => Effect.Effect<A["input"]["Type"], Schema.SchemaError>;
}

/**
 * The action's input as native flags: one per field of a struct input, named after it,
 * or `--input` taking the whole input as JSON otherwise.
 */
const inputConfig = <A extends Action.Any>(action: A): InputConfig<A> => {
  const codec = Schema.toCodecJson(action.input);
  const encoded = SchemaAST.toEncoded(codec.ast);
  const decode = Schema.decodeUnknownEffect(codec);

  // A record's keys are not known in advance, so only a struct of named fields gets flags;
  // an action without input is one, of none.
  if (
    SchemaAST.isObjects(encoded) &&
    SchemaAST.isObjects(codec.ast) &&
    encoded.indexSignatures.every((signature) => SchemaAST.isNever(signature.type))
  ) {
    return {
      config: fieldFlags(codec.ast, encoded),
      decode: (parsed) => decode(fromFields(parsed)),
    };
  }

  return {
    config: { input: inputFlag },
    // With no input, `{}` is decoded afresh each run so invocations never share a value.
    decode: (parsed) => decode(Option.getOrElse(parsed["input"] ?? Option.none(), () => ({}))),
  };
};

/**
 * One native command around an action-bound operation, its flags derived from the
 * action's input. A flag named like one the native parser or a renderer claims
 * (`--help`, `--json`, ...) is refused when the command is built: the parser would reject
 * every run.
 */
export const command = <A extends Action.Any, E, R>(
  action: A,
  execute: (input: A["input"]["Type"]) => Effect.Effect<A["success"]["Type"], E, R>,
  options?: Options<A["success"]["Type"]>,
): Command.Command<string, never, {}, E | Schema.SchemaError, R> => {
  const name = options?.name ?? kebab(action.name);
  const render = options?.render;
  const { config, decode } = inputConfig(action);

  const claimed = [...builtInFlags, ...(render === undefined ? [] : ["json"])];

  for (const flag of Object.keys(config).map(kebab)) {
    if (claimed.includes(flag)) throw new Error(`Reserved flag of ${name}: --${flag}`);
  }

  const command =
    render === undefined
      ? Command.make(name, { input: config }, ({ input }) =>
          Effect.flatMap(decode(input), (value) => output(action, execute, value, undefined)),
        )
      : Command.make(name, { input: config, json: jsonFlag }, ({ input, json }) =>
          Effect.flatMap(decode(input), (value) =>
            output(action, execute, value, json ? undefined : render),
          ),
        );

  return command.pipe(Command.withDescription(action.description));
};
