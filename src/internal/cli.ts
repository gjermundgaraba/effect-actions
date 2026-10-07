import {
  Console,
  Effect,
  Option,
  Predicate,
  Record,
  Runtime,
  Schema,
  SchemaAST,
  type Types,
} from "effect";
import { CliError, Command, Flag, Param } from "effect/cli";
import type * as Action from "../Action.js";
import { assertDistinct, literalValues, members, projectedErrors, unsuspended } from "./actions.js";
import { logToStderr } from "./console.js";
import { InvalidInput } from "./errors.js";

/**
 * The fields of `A`'s input that may be positional: the named top-level fields of a struct
 * or class input, as encoded. None for any other input, a record or a union included.
 */
export type Field<A extends Action.Any> = A["input"]["Encoded"] extends infer E
  ? true extends Types.IsUnion<E>
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
  /**
   * A short name per input field's flag, such as `{ limit: "n" }` for `-n`, given as
   * `Param.withAlias` takes it.
   */
  readonly aliases?: { readonly [K in Field<A>]?: string };
}

/**
 * `getUser` as a command or flag name: `get-user`; `getHTTPUser`: `get-http-user`; `_id`:
 * `id`, since a flag already starts with its dashes. A name of dashes and underscores alone,
 * which would be left empty, is kept as it is.
 */
export const kebab = (name: string): string => {
  const kebabbed = name
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1-$2")
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/_/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();

  return kebabbed === "" ? name : kebabbed;
};

/**
 * A command with a renderer takes `--json` as a flag of its own, so nothing is
 * claimed tree-wide and a host's `--json`, global or not, is never contested.
 * Without a renderer the output is JSON already and there is no flag.
 */
const jsonFlag = Flag.Boolean("json").pipe(
  Flag.withDefault(false),
  Flag.withDescription("Print machine-readable JSON"),
);

/** The kinds of JSON value there are. */
const jsonKinds = ["null", "boolean", "number", "string", "array", "object"] as const;

type JsonKind = (typeof jsonKinds)[number];

/** The kind of a JSON value, or of a literal's, which JSON has no bigint for. */
const kindOf = (value: Schema.Json | SchemaAST.LiteralValue): JsonKind =>
  value === null
    ? "null"
    : Predicate.isBoolean(value)
      ? "boolean"
      : Predicate.isNumber(value)
        ? "number"
        : Predicate.isString(value)
          ? "string"
          : Array.isArray(value)
            ? "array"
            : "object";

/**
 * The kinds of JSON value an encoded type accepts at its top, each member's of a union and a
 * suspended type's: its checks and what it nests aside, which the action's schema decodes.
 * A type of no fixed kind accepts all.
 */
const kindsOf = (ast: SchemaAST.AST): ReadonlyArray<JsonKind> =>
  members(ast).flatMap((member): ReadonlyArray<JsonKind> => {
    if (SchemaAST.isLiteral(member)) return [kindOf(member.literal)];

    if (SchemaAST.isEnum(member)) return member.enums.map(([, value]) => kindOf(value));

    if (SchemaAST.isNull(member)) return ["null"];

    if (SchemaAST.isBoolean(member)) return ["boolean"];

    if (SchemaAST.isNumber(member)) return ["number"];

    if (SchemaAST.isString(member) || SchemaAST.isTemplateLiteral(member)) return ["string"];

    if (SchemaAST.isArrays(member)) return ["array"];

    if (SchemaAST.isObjects(member)) return ["object"];

    return jsonKinds;
  });

/**
 * A flag's text as the JSON it holds when the field's `encoded` type accepts that kind of
 * value, or else as itself, for the action's schema to decode: for a number `21` parses,
 * while for `"auto" | string` the text `true` stays text. Only the kind is checked, so JSON
 * breaking a rule of the schema, such as a maximum length, stays JSON, and the action's
 * schema reports the rule and the path to what breaks it.
 */
const jsonOrText = (encoded: SchemaAST.AST) => {
  const accepted = new Set(kindsOf(encoded));

  return Schema.Union([
    Schema.fromJsonString(Schema.Json).check(
      Schema.makeFilter((json) => accepted.has(kindOf(json))),
    ),
    Schema.String,
  ]);
};

/** The strings a union of string literals or a string enum accepts, if it is one. */
const choices = (ast: SchemaAST.AST): ReadonlyArray<string> | undefined => {
  const accepted = members(ast).flatMap(literalValues);

  return accepted.every(Predicate.isString) ? accepted : undefined;
};

/** A flag or a positional argument. */
type Kind = Param.ParamKind;

/**
 * The native flag or argument parsing one field's encoded JSON value: a string or boolean
 * for those, a choice for string literals and string enums, and JSON or text for anything
 * else, numbers included. A template literal is a string; the action's schema checks its
 * pattern. A suspended type is read as the type it stands for. JSON or text, a flag's or an
 * argument's, is shown as `value`, not as the string it is parsed from.
 */
const valueParam = (kind: Kind, name: string, field: SchemaAST.AST): Param.Param<Kind, unknown> => {
  const encoded = unsuspended(field);
  const literals = choices(encoded);

  if (literals !== undefined) return Param.Literals(kind, name, literals);

  if (SchemaAST.isString(encoded) || SchemaAST.isTemplateLiteral(encoded)) {
    return Param.String(kind, name);
  }

  if (SchemaAST.isBoolean(encoded)) return Param.Boolean(kind, name);

  return Param.String(kind, name).pipe(
    Param.withSchema(jsonOrText(encoded)),
    Param.withMetavar("value"),
  );
};

/**
 * An optional field's value without the absence `Schema.optional` adds to it: `undefined`
 * declared, `null` encoded. Omitting the flag already leaves the field out, so
 * `optional(Schema.String)` takes a plain string.
 */
const present = (ast: SchemaAST.AST): SchemaAST.AST => {
  const members = SchemaAST.isUnion(ast)
    ? ast.types.filter((member) => !SchemaAST.isNull(member) && !SchemaAST.isUndefined(member))
    : [];

  return members.length === 1 && members[0] !== undefined ? members[0] : ast;
};

/**
 * Whether `Schema.optional` added the field's JSON `null`: encoded without the JSON codec,
 * its value admits `undefined` but not `null`. A `null` of the field's own schema, as
 * `NullOr` or `OptionFromNullOr` encode, stays.
 */
const addsNull = (plain: SchemaAST.AST): boolean => {
  const types = members(plain);

  return types.some(SchemaAST.isUndefined) && !types.some(SchemaAST.isNull);
};

/**
 * The element of an encoded array a flag repeats, and how many times it must: an array of
 * strings or numbers, choices included, whose fixed first elements, if any, are its rest's,
 * as `Schema.NonEmptyArray` writes one. `undefined` for any other array, which takes JSON.
 */
const repeated = (
  ast: SchemaAST.AST,
): { readonly element: SchemaAST.AST; readonly min: number } | undefined => {
  const encoded = unsuspended(ast);

  if (!SchemaAST.isArrays(encoded)) return undefined;

  const [element, ...after] = encoded.rest;

  if (
    element === undefined ||
    after.length > 0 ||
    !encoded.elements.every((first) => first === element) ||
    !kindsOf(element).every((kind) => kind === "string" || kind === "number")
  ) {
    return undefined;
  }

  return { element, min: encoded.elements.length };
};

/** The occurrence of a repeated flag that adds no element, so `--tag '[]'` alone is `[]`. */
const empty = "[]";

/**
 * A field's flag or argument, `None` when omitted, from its JSON encoding and its plain one.
 * A required field's is required, so the parser reports it missing; a required boolean flag
 * is a switch instead: omitted, it is `false`, as a switch reads. A boolean argument takes
 * `true` or `false`. A flag or argument of an array of strings or numbers is repeated, one
 * element per occurrence but `[]`, which adds none, and a choice among the element's: none
 * is `[]`, or leaves an optional field out, which `[]` gives instead.
 */
const fieldParam = (
  kind: Kind,
  name: string,
  encoded: SchemaAST.AST,
  plain: SchemaAST.AST | undefined,
): Pick<FieldParam, "param" | "repeats"> => {
  const optional = SchemaAST.isOptional(encoded);
  const value = optional && plain !== undefined && addsNull(plain) ? present(encoded) : encoded;
  const repeats = repeated(value);

  if (repeats !== undefined) {
    const literals = choices(unsuspended(repeats.element));

    const elements =
      literals === undefined
        ? valueParam(kind, name, repeats.element)
        : Param.Literals(kind, name, [...literals, empty]);

    const listed = (values: ReadonlyArray<unknown>) =>
      Option.some(values.filter((value) => value !== empty));

    return {
      param: optional
        ? Param.variadic(elements).pipe(
            Param.map((values) => (values.length === 0 ? Option.none() : listed(values))),
          )
        : Param.variadic(elements, { min: repeats.min }).pipe(Param.map(listed)),
      repeats: true,
    };
  }

  if (optional) return { param: Param.optional(valueParam(kind, name, value)), repeats: false };

  return {
    param:
      kind === Param.flagKind && SchemaAST.isBoolean(unsuspended(encoded))
        ? Flag.Boolean(name).pipe(Flag.withDefault(false), Flag.map(Option.some))
        : valueParam(kind, name, encoded).pipe(Param.map(Option.some)),
    repeats: false,
  };
};

/** One input field's flag or argument, parsed as its encoded value, `None` when omitted. */
interface FieldParam {
  readonly field: string;
  readonly param: Param.Param<Kind, Option.Option<unknown>>;
  /** Whether the field may be left out, and so its argument too. */
  readonly optional: boolean;
  /** Whether it is repeated, an argument taking every value left, so read last. */
  readonly repeats: boolean;
}

/** What the field parameters parse to, by field. */
type Parsed = Readonly<Record<string, Option.Option<unknown>>>;

/**
 * The fields of a struct, or of a class, which declares them as its one type parameter, by name.
 */
const fieldsOf = (ast: SchemaAST.AST): ReadonlyMap<PropertyKey, SchemaAST.AST> => {
  const fields = SchemaAST.isDeclaration(ast) ? ast.typeParameters[0] : ast;

  return new Map(
    fields !== undefined && SchemaAST.isObjects(fields)
      ? fields.propertySignatures.map((property) => [property.name, property.type])
      : [],
  );
};

/** A struct, or a class's, transformed as a whole, as `Schema.encodeKeys` transforms one. */
const transformedWhole = (ast: SchemaAST.AST): boolean =>
  (SchemaAST.isDeclaration(ast) ? ast.typeParameters[0] : ast)?.encoding !== undefined;

/** A field's description: its own, or the first a suspension it stands for has. */
const descriptionOf = (ast: SchemaAST.AST): string | undefined =>
  SchemaAST.resolveDescription(ast) ??
  (SchemaAST.isSuspend(ast) ? descriptionOf(ast.thunk()) : undefined);

/**
 * One flag or argument per top-level field of a struct input, named after the field in
 * kebab case, parsed as its encoded value and described by its declared schema: an
 * argument for a field listed in `positional`, a flag otherwise. A field required once
 * encoded is required; the action's schema still decodes what they parse.
 */
const fieldParams = (
  encoded: SchemaAST.Objects,
  input: SchemaAST.AST,
  positional: ReadonlyArray<string>,
  aliases: Readonly<Record<string, string | undefined>>,
): ReadonlyArray<FieldParam> => {
  // Encoded without the JSON codec, a field still tells `undefined` from `null`, under its
  // encoded name. Declared, it keeps the description encoding drops from a transformed
  // field, such as `Schema.FiniteFromString`, under its declared name, unless the struct is
  // transformed as a whole, as `Schema.encodeKeys` does: its names may then be swapped.
  const plain = fieldsOf(SchemaAST.toEncoded(input));
  const described = fieldsOf(transformedWhole(input) ? encoded : SchemaAST.toType(input));

  return encoded.propertySignatures.map((property) => {
    const field = String(property.name);
    const declaredField = described.get(property.name);
    const kind = positional.includes(field) ? Param.argumentKind : Param.flagKind;

    const { param, repeats } = fieldParam(
      kind,
      kebab(field),
      property.type,
      plain.get(property.name),
    );

    const alias = kind === Param.flagKind ? aliases[field] : undefined;
    const aliased = alias === undefined ? param : Param.withAlias(param, alias);
    const documented = declaredField ?? property.type;

    // Described as a whole, as `optional(X).annotate(...)`, or as its value.
    const description = descriptionOf(documented) ?? descriptionOf(present(documented));

    return {
      field,
      param: description === undefined ? aliased : Param.withDescription(aliased, description),
      optional: SchemaAST.isOptional(property.type),
      repeats,
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

  // A repeated argument takes every value left, so none can follow it.
  const greedy = ordered.slice(0, -1).find((param) => param.repeats);

  if (greedy !== undefined) {
    throw new Error(`Repeated positional argument before another one: ${greedy.field}`);
  }

  return ordered;
};

/**
 * `--input`, the whole encoded input as JSON, or text, for an input that is not a struct of
 * fields. It is never required: left off, it is `{}`, which the action's schema decodes
 * when the command runs, never when it is built.
 */
const inputFlag = (encoded: SchemaAST.AST) =>
  Flag.String("input").pipe(
    Flag.withSchema(jsonOrText(encoded)),
    Flag.withDescription("Whole action input as JSON; omitted, {}"),
    Flag.optional,
  );

/**
 * What a success prints on stdout: its JSON, or `render`'s text. It is validated and encoded
 * first, so human output cannot conceal an invalid success, which is a defect, as on a server.
 * An action that returns nothing prints nothing, rather than its encoding, `null`.
 */
const output = <A extends Action.Any>(
  action: A,
  value: A["success"]["Type"],
  render: ((output: A["success"]["Type"]) => string) | undefined,
): Effect.Effect<Option.Option<string>> =>
  Effect.map(
    Effect.orDie(Schema.encodeEffect(Schema.toCodecJson(action.success))(value)),
    (encoded) =>
      render === undefined && SchemaAST.isVoid(action.success.ast)
        ? Option.none()
        : Option.some(render === undefined ? JSON.stringify(encoded, null, 2) : render(value)),
  );

/**
 * What a command fails with when its action fails: Effect CLI's own error for a handler's
 * failure, which `Command.run` prints on stderr and marks reported, so `runMain` does not
 * print it again. Its `cause` is the action's failure. The process exits with the cause's
 * `Runtime.errorExitCode`, 1 by default.
 */
export class UserError<out E = unknown> extends CliError.UserError {
  declare readonly cause: E;

  /**
   * The action's failure, as Effect names an error's nested one, so the native
   * `Effect.catchReason("UserError", "UserNotFound", f)` and `catchReasons` match it by tag.
   */
  get reason(): E {
    return this.cause;
  }

  override get [Runtime.errorExitCode](): number {
    return Runtime.getErrorExitCode(this.cause);
  }
}

/** `error`'s own `_tag` or `message`, when it is a string. */
const text = <E>(error: E, key: "_tag" | "message"): string | undefined => {
  if (!Predicate.hasProperty(error, key)) return undefined;

  const value = error[key];

  return Predicate.isString(value) ? value : undefined;
};

/**
 * A failure no projected schema encodes, without a stack: its tag or an error's name, and
 * its message, or the failure itself when it is a string, then each cause's, so a transport
 * error keeps the refused connection beneath it, up to one already described, as a cycle
 * repeats it. Its other fields are left out, a plain object's `name` too: no schema says
 * they are safe to show, and a builder's failure may hold a connection string.
 */
const described = <E>(error: E, seen: Set<unknown> = new Set()): string => {
  const name = text(error, "_tag") ?? (error instanceof Error ? error.name : "Error");
  const message = Predicate.isString(error) ? error : (text(error, "message") ?? "");
  const named = message === "" ? name : `${name}: ${message}`;

  seen.add(error);

  return Predicate.hasProperty(error, "cause") &&
    error.cause !== undefined &&
    !seen.has(error.cause)
    ? `${named}: ${described(error.cause, seen)}`
    : named;
};

/**
 * The `UserError` of each failure of `action`, its message the JSON HTTP sends for it: encoded
 * by the first schema that takes it among the built-in errors, the action's and the
 * surface's own `errors`, as an Effect, as HTTP encodes it. A failure none takes, such as a
 * builder's or the transport's, is described instead.
 */
const failureOf = <E>(action: Action.Any, errors: Action.Any["error"]) => {
  const encode = Schema.encodeUnknownEffect(
    Schema.fromJsonString(Schema.toCodecJson(Schema.Union(projectedErrors(action, errors)))),
  );

  return (error: E) =>
    encode(error).pipe(
      Effect.orElseSucceed(() => described(error)),
      Effect.flatMap((userMessage) => Effect.fail(new UserError<E>({ cause: error, userMessage }))),
    );
};

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
  aliases: Readonly<Record<string, string | undefined>>,
): InputConfig<A> => {
  const codec = Schema.toCodecJson(action.input);
  // A suspended input, as a recursive schema is written, is the input it stands for.
  const encoded = unsuspended(SchemaAST.toEncoded(codec.ast));
  // Undeclared fields are refused, as over HTTP: a misspelled key is an error, not dropped.
  const decode = Schema.decodeUnknownEffect(codec, { onExcessProperty: "error" });

  // Encoded, a struct or a class is its named fields. A record's keys are not known in
  // advance, so only named fields get flags; an action without input has none.
  if (
    SchemaAST.isObjects(encoded) &&
    encoded.indexSignatures.every((signature) => SchemaAST.isNever(signature.type))
  ) {
    const params = fieldParams(encoded, unsuspended(action.input.ast), positional, aliases);

    const flagged = new Set(
      params.map(({ field }) => field).filter((field) => !positional.includes(field)),
    );

    const stray = Object.keys(aliases).find((field) => !flagged.has(field));

    if (stray !== undefined) throw new Error(`Not a flag's input field: ${stray}`);

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

  if (Object.keys(aliases).length > 0) {
    throw new Error(`Aliases need named input fields: ${Object.keys(aliases).join(", ")}`);
  }

  return {
    flags: { input: inputFlag(encoded) },
    positional: [],
    // `--input` left off is `{}`, a fresh one each run, so invocations never share a value.
    // The schema decides whether it is valid, when the command runs.
    decode: (parsed) => decode(Option.getOrElse(parsed["input"] ?? Option.none(), () => ({}))),
  };
};

/**
 * One native command around an action-bound operation, its flags and positional
 * arguments derived from the action's input. A field's flag shadows a global flag of the
 * same name; two flags of the command itself with one name are refused when it is built.
 * Input that does not decode is `InvalidInput`, as over HTTP, and the operation writes its
 * logs and console output to stderr, since stdout carries the result. Every failure is a
 * `UserError`, encoded with the surface's `errors` too, such as a binding's.
 */
export const command = <A extends Action.Any, E, R>(
  action: A,
  execute: (input: A["input"]["Type"]) => Effect.Effect<A["success"]["Type"], E, R>,
  options?: Options<A>,
  errors: Action.Any["error"] = [],
): Command.Command<string, never, {}, UserError<E | InvalidInput>, R> => {
  const name = options?.name ?? kebab(action.name);
  const render = options?.render;

  const { flags, positional, decode } = inputConfig(
    action,
    options?.positional ?? [],
    options?.aliases ?? {},
  );

  const failure = failureOf<E | InvalidInput>(action, errors);

  // Two fields of one kebab-case name, a `json` field beside a renderer's `--json`, or an alias
  // another flag's name or alias takes, its leading dashes dropped as `Param.withAlias` drops them:
  // native flags share one namespace of names, which a command checks only when it parses. Global
  // flags are not claimed: a field's flag shadows one on its command.
  assertDistinct(
    "flag",
    [
      ...Object.keys(flags).map((field) => [`--${kebab(field)}`, `field ${field}`] as const),
      ...(render === undefined ? [] : [["--json", "render's --json"] as const]),
      ...Object.entries(options?.aliases ?? {}).flatMap(([field, alias]) =>
        Predicate.isString(alias)
          ? [[`--${alias.replace(/^-+/, "")}`, `alias of field ${field}`] as const]
          : [],
      ),
    ],
    ([flag]) => flag,
    ([, claimant]) => claimant,
  );

  const args = positional.map(({ param }) => param);

  // Every field the flags and the arguments parsed, by name.
  const parsedFields = (input: Parsed, values: ReadonlyArray<Option.Option<unknown>>) => ({
    ...input,
    ...Object.fromEntries(
      positional.map(({ field }, index) => [field, values[index] ?? Option.none()] as const),
    ),
  });

  // Everything the command runs writes to stderr, its codecs included: stdout carries only
  // the result, printed last.
  const run = (parsed: Parsed, rendered: ((output: A["success"]["Type"]) => string) | undefined) =>
    decode(parsed).pipe(
      Effect.mapError(InvalidInput.fromSchemaError),
      Effect.flatMap(execute),
      Effect.catch(failure),
      Effect.flatMap((value) => output(action, value, rendered)),
      logToStderr,
      Effect.flatMap(Option.match({ onNone: () => Effect.void, onSome: Console.log })),
    );

  const command =
    render === undefined
      ? Command.make(name, { input: flags, args }, ({ input, args: values }) =>
          run(parsedFields(input, values), undefined),
        )
      : Command.make(
          name,
          { input: flags, args, json: jsonFlag },
          ({ input, args: values, json }) =>
            run(parsedFields(input, values), json ? undefined : render),
        );

  return command.pipe(Command.withDescription(action.description));
};
