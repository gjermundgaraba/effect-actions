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

/** Any JSON value, as one flag's text. */
const jsonValue = Schema.fromJsonString(Schema.Json);

/** The values a literal or an enum accepts; nothing else has a fixed set. */
const values = (ast: SchemaAST.AST): ReadonlyArray<unknown> =>
  SchemaAST.isLiteral(ast)
    ? [ast.literal]
    : SchemaAST.isEnum(ast)
      ? ast.enums.map(([, value]) => value)
      : [undefined];

/** The strings a union of string literals or a string enum accepts, if it is one. */
const choices = (ast: SchemaAST.AST): ReadonlyArray<string> | undefined => {
  const accepted = (SchemaAST.isUnion(ast) ? ast.types : [ast]).flatMap(values);

  return accepted.every(Predicate.isString) ? accepted : undefined;
};

/** How JSON encodes `Schema.Number`'s non-finite values, which a number flag does not take. */
const nonFinite = new Set(["Infinity", "-Infinity", "NaN"]);

/**
 * A number, alone, as `Schema.Number` encodes it, or a numeric enum. A number beside any
 * other string, such as `"auto"`, is not: a number flag would refuse the string.
 */
const numeric = (ast: SchemaAST.AST): boolean =>
  SchemaAST.isNumber(ast) ||
  (SchemaAST.isEnum(ast) && values(ast).every(Predicate.isNumber)) ||
  (SchemaAST.isUnion(ast) &&
    ast.types.some(SchemaAST.isNumber) &&
    ast.types.every(
      (member) =>
        SchemaAST.isNumber(member) ||
        (choices(member)?.every((literal) => nonFinite.has(literal)) ?? false),
    ));

/**
 * The native flag parsing one field's encoded JSON value: a string, number or boolean
 * flag for those, a choice for string literals and string enums, and a JSON flag for
 * anything else. A template literal is a string; the action's schema checks its pattern.
 */
const valueFlag = (name: string, encoded: SchemaAST.AST): Flag.Flag<unknown> => {
  const literals = choices(encoded);

  if (literals !== undefined) return Flag.Literals(name, literals);

  if (SchemaAST.isString(encoded) || SchemaAST.isTemplateLiteral(encoded)) {
    return Flag.String(name);
  }

  if (numeric(encoded)) return Flag.Finite(name);

  if (SchemaAST.isBoolean(encoded)) return Flag.Boolean(name);

  return Flag.String(name).pipe(Flag.withSchema(jsonValue), Flag.withMetavar("json"));
};

/**
 * An optional field's value without the absence `Schema.optional` adds to it: `undefined`
 * declared, `null` encoded. Omitting the flag already leaves the field out, so
 * `optional(Schema.String)` takes a plain string. A field that declares `null` itself keeps
 * it, as `optionalKey(NullOr(Schema.String))` does.
 */
const present = (ast: SchemaAST.AST): SchemaAST.AST => {
  const members = SchemaAST.isUnion(ast)
    ? ast.types.filter((member) => !SchemaAST.isNull(member) && !SchemaAST.isUndefined(member))
    : [];

  return members.length === 1 && members[0] !== undefined ? members[0] : ast;
};

/** Whether a declared value may be `null`. */
const nullable = (ast: SchemaAST.AST): boolean =>
  SchemaAST.isNull(ast) || (SchemaAST.isUnion(ast) && ast.types.some(nullable));

/**
 * A field's flag, `None` when omitted. A required field's flag is required, so the parser
 * reports it missing; a required boolean is a switch instead: omitted, it is `false`, as a
 * switch reads.
 */
const fieldFlag = (
  name: string,
  encoded: SchemaAST.AST,
  declared: SchemaAST.AST | undefined,
): Flag.Flag<Option.Option<unknown>> =>
  !SchemaAST.isOptional(encoded)
    ? SchemaAST.isBoolean(encoded)
      ? Flag.Boolean(name).pipe(Flag.withDefault(false), Flag.map(Option.some))
      : valueFlag(name, encoded).pipe(Flag.map(Option.some))
    : Flag.optional(
        valueFlag(name, declared !== undefined && nullable(declared) ? encoded : present(encoded)),
      );

/** One flag per input field, parsed as the field's encoded value, `None` when omitted. */
type FieldFlags = Readonly<Record<string, Flag.Flag<Option.Option<unknown>>>>;

/** What `FieldFlags` parse to, by field. */
type Parsed = Readonly<Record<string, Option.Option<unknown>>>;

/**
 * The fields of a struct or class as declared, by name. Encoding drops the description of
 * a transformed field, such as `Schema.Number` or `Schema.FiniteFromString`; here it stays.
 */
const declaredFields = (ast: SchemaAST.AST): ReadonlyMap<PropertyKey, SchemaAST.AST> => {
  const type = SchemaAST.toType(ast);
  // A class declares its fields as its one type parameter.
  const fields = SchemaAST.isDeclaration(type) ? type.typeParameters[0] : type;

  return new Map(
    fields !== undefined && SchemaAST.isObjects(fields)
      ? fields.propertySignatures.map((property) => [property.name, property.type])
      : [],
  );
};

/**
 * One flag per top-level field of a struct input, named after the field in kebab case,
 * parsed as its encoded value and described by its declared schema. A field required once
 * encoded has a required flag; the action's schema still decodes what they parse.
 */
const fieldFlags = (encoded: SchemaAST.Objects, declared: SchemaAST.AST): FieldFlags => {
  const described = declaredFields(declared);

  return Object.fromEntries(
    encoded.propertySignatures.map((property) => {
      const field = described.get(property.name);
      const flag = fieldFlag(kebab(String(property.name)), property.type, field);
      const documented = field ?? property.type;

      // Described as a whole, as `optional(X).annotate(...)`, or as its value.
      const description =
        SchemaAST.resolveDescription(documented) ??
        SchemaAST.resolveDescription(present(documented));

      return [
        String(property.name),
        description === undefined ? flag : Flag.withDescription(flag, description),
      ] as const;
    }),
  );
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

    // An action that returns nothing prints nothing, rather than its encoding, `null`.
    if (render === undefined && SchemaAST.isVoid(action.success.ast)) return;

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

  // Encoded, a struct or a class is its named fields. A record's keys are not known in
  // advance, so only named fields get flags; an action without input has none.
  if (
    SchemaAST.isObjects(encoded) &&
    encoded.indexSignatures.every((signature) => SchemaAST.isNever(signature.type))
  ) {
    return {
      config: fieldFlags(encoded, action.input.ast),
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
 * action's input. A field's flag shadows a global flag of the same name; two flags of the
 * command itself with one name are refused when it is built.
 */
export const command = <A extends Action.Any, E, R>(
  action: A,
  execute: (input: A["input"]["Type"]) => Effect.Effect<A["success"]["Type"], E, R>,
  options?: Options<A["success"]["Type"]>,
): Command.Command<string, never, {}, E | Schema.SchemaError, R> => {
  const name = options?.name ?? kebab(action.name);
  const render = options?.render;
  const { config, decode } = inputConfig(action);

  // Two fields of one kebab-case name, or a `json` field beside a renderer's `--json`.
  // Global flags are not claimed: a field's flag shadows one on its command.
  assertDistinct(
    "flag",
    [
      ...Object.keys(config).map((field) => [`--${kebab(field)}`, `field ${field}`] as const),
      ...(render === undefined ? [] : [["--json", "render's --json"] as const]),
    ],
    ([flag]) => flag,
    ([, claimant]) => claimant,
  );

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
