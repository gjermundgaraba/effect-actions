import { Console, Effect, Option, Predicate, Record, Schema, SchemaAST } from "effect";
import { Command, Flag, Param } from "effect/unstable/cli";
import type * as Action from "../Action.js";
import { assertDistinct } from "./actions.js";

/** Whether `T` is a union of several types. */
type IsUnion<T, U = T> = T extends unknown ? ([U] extends [T] ? false : true) : never;

/**
 * The fields of `A`'s input that may be positional: the named top-level fields of a struct
 * or class input, as encoded. None for any other input, a record or a union included.
 */
export type Field<A extends Action.Any> = A["input"]["Encoded"] extends infer E
  ? true extends IsUnion<E>
    ? never
    : E extends ReadonlyArray<unknown>
      ? never
      : E extends object
        ? string extends keyof E
          ? never
          : Extract<keyof E, string>
        : never
  : never;

/** How one command is named, takes its input and prints its result. */
export interface Options<A extends Action.Any> {
  /** Override the command name. The action name, in kebab case, is used by default. */
  readonly name?: string;
  /** Human output. Adds a `--json` flag to the command that selects JSON instead. */
  readonly render?: (output: A["success"]["Type"]) => string;
  /**
   * Input fields taken as positional arguments instead of flags, in this order. An
   * optional field is an optional argument, so it follows every required one.
   */
  readonly positional?: ReadonlyArray<Field<A>>;
}

/** `getUser` as a command or flag name: `get-user`; `getHTTPUser`: `get-http-user`. */
export const kebab = (name: string): string =>
  name
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1-$2")
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

/**
 * A flag's text as the JSON it holds when the field's `encoded` type accepts that value, or
 * else as itself, for the action's schema to decode: for a number `21` parses, while for
 * `"auto" | string` the text `true` stays text. The JSON is only checked, never decoded
 * here, so no key another union member needs is dropped before the action's schema sees it.
 */
const jsonOrText = (encoded: SchemaAST.AST) => {
  const accepts = Schema.is(Schema.make<Schema.Codec<unknown>>(encoded));

  return Schema.Union([
    Schema.fromJsonString(Schema.Json).check(Schema.makeFilter(accepts)),
    Schema.String,
  ]);
};

/** The values a literal or an enum accepts; nothing else has a fixed set. */
const values = (ast: SchemaAST.AST): ReadonlyArray<unknown> =>
  SchemaAST.isLiteral(ast)
    ? [ast.literal]
    : SchemaAST.isEnum(ast)
      ? ast.enums.map(([, value]) => value)
      : [undefined];

/** The members of a union, those of nested unions included, or the one type otherwise. */
const members = (ast: SchemaAST.AST): ReadonlyArray<SchemaAST.AST> =>
  SchemaAST.isUnion(ast) ? ast.types.flatMap(members) : [ast];

/** The strings a union of string literals or a string enum accepts, if it is one. */
const choices = (ast: SchemaAST.AST): ReadonlyArray<string> | undefined => {
  const accepted = members(ast).flatMap(values);

  return accepted.every(Predicate.isString) ? accepted : undefined;
};

/** A flag or a positional argument. */
type Kind = Param.ParamKind;

/**
 * The native flag or argument parsing one field's encoded JSON value: a string or boolean
 * for those, a choice for string literals and string enums, and JSON or text for anything
 * else, numbers included. A template literal is a string; the action's schema checks its
 * pattern. An argument is shown by its name, a flag's JSON or text as `value`.
 */
const valueParam = (
  kind: Kind,
  name: string,
  encoded: SchemaAST.AST,
): Param.Param<Kind, unknown> => {
  const literals = choices(encoded);

  if (literals !== undefined) return Param.Literals(kind, name, literals);

  if (SchemaAST.isString(encoded) || SchemaAST.isTemplateLiteral(encoded)) {
    return Param.String(kind, name);
  }

  if (SchemaAST.isBoolean(encoded)) return Param.Boolean(kind, name);

  const text = Param.String(kind, name).pipe(Param.withSchema(jsonOrText(encoded)));

  return kind === Param.flagKind ? Param.withMetavar(text, "value") : text;
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
 * A field's flag or argument, `None` when omitted. A required field's is required, so the
 * parser reports it missing; a required boolean flag is a switch instead: omitted, it is
 * `false`, as a switch reads. A boolean argument takes `true` or `false`.
 */
const fieldParam = (
  kind: Kind,
  name: string,
  encoded: SchemaAST.AST,
  declared: SchemaAST.AST | undefined,
): Param.Param<Kind, Option.Option<unknown>> =>
  !SchemaAST.isOptional(encoded)
    ? kind === Param.flagKind && SchemaAST.isBoolean(encoded)
      ? Flag.Boolean(name).pipe(Flag.withDefault(false), Flag.map(Option.some))
      : valueParam(kind, name, encoded).pipe(Param.map(Option.some))
    : Param.optional(
        valueParam(
          kind,
          name,
          declared !== undefined && nullable(declared) ? encoded : present(encoded),
        ),
      );

/** One input field's flag or argument, parsed as its encoded value, `None` when omitted. */
interface FieldParam {
  readonly field: string;
  readonly param: Param.Param<Kind, Option.Option<unknown>>;
  /** Whether the field may be left out, and so its argument too. */
  readonly optional: boolean;
}

/** What the field parameters parse to, by field. */
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
 * One flag or argument per top-level field of a struct input, named after the field in
 * kebab case, parsed as its encoded value and described by its declared schema: an
 * argument for a field listed in `positional`, a flag otherwise. A field required once
 * encoded is required; the action's schema still decodes what they parse.
 */
const fieldParams = (
  encoded: SchemaAST.Objects,
  declared: SchemaAST.AST,
  positional: ReadonlyArray<string>,
): ReadonlyArray<FieldParam> => {
  const described = declaredFields(declared);

  return encoded.propertySignatures.map((property) => {
    const field = String(property.name);
    const declaredField = described.get(property.name);
    const kind = positional.includes(field) ? Param.argumentKind : Param.flagKind;
    const param = fieldParam(kind, kebab(field), property.type, declaredField);
    const documented = declaredField ?? property.type;

    // Described as a whole, as `optional(X).annotate(...)`, or as its value.
    const description =
      SchemaAST.resolveDescription(documented) ?? SchemaAST.resolveDescription(present(documented));

    return {
      field,
      param: description === undefined ? param : Param.withDescription(param, description),
      optional: SchemaAST.isOptional(property.type),
    };
  });
};

/**
 * The positional fields in order, checked against the fields there are: each one a field,
 * listed once, and every required one before any optional one, as a parser reads them.
 */
const positionalOrder = (
  params: ReadonlyArray<FieldParam>,
  positional: ReadonlyArray<string>,
): ReadonlyArray<FieldParam> => {
  assertDistinct("positional argument", positional, (field) => field);

  const ordered = positional.map((field) => {
    const found = params.find((param) => param.field === field);

    if (found === undefined) throw new Error(`Not an input field: ${field}`);

    return found;
  });

  const firstOptional = ordered.findIndex((param) => param.optional);
  const late = ordered.slice(firstOptional === -1 ? ordered.length : firstOptional);
  const misplaced = late.find((param) => !param.optional);

  if (misplaced !== undefined) {
    throw new Error(`Required positional argument after an optional one: ${misplaced.field}`);
  }

  return ordered;
};

/** The whole encoded input as JSON, or text, for an input that is not a struct of fields. */
const inputFlag = (encoded: SchemaAST.AST) =>
  Flag.String("input").pipe(
    Flag.withSchema(jsonOrText(encoded)),
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

/** An action's input as native flags and positional arguments, and how to decode them. */
interface InputConfig<A extends Action.Any> {
  /** Flags by field; `input` for the whole input when it is not a struct. */
  readonly flags: Readonly<Record<string, Param.Param<Kind, Option.Option<unknown>>>>;
  /** Positional fields, in the order they are read. */
  readonly positional: ReadonlyArray<FieldParam>;
  readonly decode: (parsed: Parsed) => Effect.Effect<A["input"]["Type"], Schema.SchemaError>;
}

/**
 * The action's input as native flags: one per field of a struct input, named after it,
 * or `--input` taking the whole input as JSON otherwise. The `positional` fields of a
 * struct are arguments instead, in that order.
 */
const inputConfig = <A extends Action.Any>(
  action: A,
  positional: ReadonlyArray<string>,
): InputConfig<A> => {
  const codec = Schema.toCodecJson(action.input);
  const encoded = SchemaAST.toEncoded(codec.ast);
  const decode = Schema.decodeUnknownEffect(codec);

  // Encoded, a struct or a class is its named fields. A record's keys are not known in
  // advance, so only named fields get flags; an action without input has none.
  if (
    SchemaAST.isObjects(encoded) &&
    encoded.indexSignatures.every((signature) => SchemaAST.isNever(signature.type))
  ) {
    const params = fieldParams(encoded, action.input.ast, positional);

    return {
      flags: Object.fromEntries(
        params.flatMap(({ field, param }) => (positional.includes(field) ? [] : [[field, param]])),
      ),
      positional: positionalOrder(params, positional),
      decode: (parsed) => decode(Record.getSomes(parsed)),
    };
  }

  if (positional.length > 0) {
    throw new Error(`Positional arguments need named input fields: ${positional.join(", ")}`);
  }

  return {
    flags: { input: inputFlag(encoded) },
    positional: [],
    // With no input, `{}` is decoded afresh each run so invocations never share a value.
    decode: (parsed) => decode(Option.getOrElse(parsed["input"] ?? Option.none(), () => ({}))),
  };
};

/**
 * One native command around an action-bound operation, its flags and positional
 * arguments derived from the action's input. A field's flag shadows a global flag of the
 * same name; two flags of the command itself with one name are refused when it is built.
 */
export const command = <A extends Action.Any, E, R>(
  action: A,
  execute: (input: A["input"]["Type"]) => Effect.Effect<A["success"]["Type"], E, R>,
  options?: Options<A>,
): Command.Command<string, never, {}, E | Schema.SchemaError, R> => {
  const name = options?.name ?? kebab(action.name);
  const render = options?.render;
  const { flags, positional, decode } = inputConfig(action, options?.positional ?? []);

  // Two fields of one kebab-case name, or a `json` field beside a renderer's `--json`.
  // Global flags are not claimed: a field's flag shadows one on its command.
  assertDistinct(
    "flag",
    [
      ...Object.keys(flags).map((field) => [`--${kebab(field)}`, `field ${field}`] as const),
      ...(render === undefined ? [] : [["--json", "render's --json"] as const]),
    ],
    ([flag]) => flag,
    ([, claimant]) => claimant,
  );

  const args = positional.map(({ param }) => param);

  // Every field the flags and the arguments parsed, by name.
  const fieldsOf = (input: Parsed, values: ReadonlyArray<Option.Option<unknown>>) => ({
    ...input,
    ...Object.fromEntries(
      positional.map(({ field }, index) => [field, values[index] ?? Option.none()] as const),
    ),
  });

  const command =
    render === undefined
      ? Command.make(name, { input: flags, args }, ({ input, args: values }) =>
          Effect.flatMap(decode(fieldsOf(input, values)), (value) =>
            output(action, execute, value, undefined),
          ),
        )
      : Command.make(
          name,
          { input: flags, args, json: jsonFlag },
          ({ input, args: values, json }) =>
            Effect.flatMap(decode(fieldsOf(input, values)), (value) =>
              output(action, execute, value, json ? undefined : render),
            ),
        );

  return command.pipe(Command.withDescription(action.description));
};
