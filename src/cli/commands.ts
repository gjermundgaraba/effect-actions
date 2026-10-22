import {
  Console,
  Effect,
  Option,
  Predicate,
  Record,
  Runtime,
  Schema,
  SchemaAST,
  Stdio,
  Stream,
  type Types,
} from "effect";
import { CliError, Command, Flag, Param } from "effect/cli";
import type * as Action from "../contract/Action.js";
import { assertDistinct } from "../contract/names.js";
import { literalValues, members, unsuspended } from "../contract/ast.js";
import { withStderrConsole } from "../stdio/console.js";
import { InvalidInput } from "../contract/errors.js";
import { decodeInput } from "../contract/call.js";
import { errorSchemas } from "../contract/declared.js";

type Field<A extends Action.Any> = A["input"]["Encoded"] extends infer E
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

// Why: Required fields only. An empty stdin for an optional field would have to mean either an
// empty value or the field left out.
type StdinField<A extends Action.Any> = A["input"]["Encoded"] extends infer E
  ? Exclude<Field<A>, { [K in keyof E]-?: {} extends Pick<E, K> ? K : never }[keyof E]>
  : never;

/** How one command of `A` is named, takes its input and prints its result. */
export interface Options<A extends Action.Any> {
  /** Override the command name. The action name, in kebab case, is used by default. */
  readonly name?: string;
  /**
   * The command's help, where the CLI's command differs from the action, such as one rendering
   * a summary: `"List the open issues, one per line."`. The action's `description` is used by
   * default, and stays what HTTP, MCP and RPC describe. With `stdin`, the paragraph naming the
   * field stdin fills follows it.
   */
  readonly description?: string;
  /**
   * Human output: the decoded success to text for a person. Adds a `--json` flag to the
   * command that selects JSON instead.
   */
  readonly render?: (output: A["success"]["Type"]) => string;
  /**
   * Input fields taken as positional arguments instead of flags, in this order: `["id"]` takes
   * `get-note 7` for `--id 7`. An optional field is an optional argument, and an array field
   * takes every argument left, one element each.
   *
   * **Gotchas**
   *
   * - A field listed here has no flag: `--<field>` is `Unrecognized flag`, so pass its value as an argument.
   */
  readonly positional?: ReadonlyArray<Field<A>>;
  /**
   * A short name per input field's flag, such as `{ limit: "n" }` for `-n 5` beside
   * `--limit 5`, given as `Param.withAlias` takes it.
   */
  readonly aliases?: { readonly [K in Field<A>]?: string };
  /**
   * A required field read from stdin instead of a flag, such as a secret, which a flag would
   * leave in the process list and the shell's history, or a document. The value is all of
   * stdin until it closes, without the line endings that end it.
   *
   * **Gotchas**
   *
   * - A terminal is never read: run interactively, the command fails with `InvalidInput`.
   * - The command waits without output until stdin closes: a parent process holding the pipe, or `ssh` without `-n`, keeps it open, so redirect stdin from a file or `/dev/null`.
   */
  readonly stdin?: StdinField<A>;
}

export const kebab = (name: string): string => {
  const kebabbed = name
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1-$2")
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/_/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();

  return kebabbed === "" ? name : kebabbed;
};

const renderedCommandJsonFlag = Flag.Boolean("json").pipe(
  Flag.withDefault(false),
  Flag.withDescription("Print machine-readable JSON"),
);

const jsonKinds = ["null", "boolean", "number", "string", "array", "object"] as const;

type JsonKind = (typeof jsonKinds)[number];

const jsonKindOf = (value: Schema.Json | SchemaAST.LiteralValue): JsonKind =>
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

const acceptedJsonKindsOf = (ast: SchemaAST.AST): ReadonlyArray<JsonKind> =>
  members(ast).flatMap((member): ReadonlyArray<JsonKind> => {
    if (SchemaAST.isLiteral(member)) return [jsonKindOf(member.literal)];

    if (SchemaAST.isEnum(member)) return member.enums.map(([, value]) => jsonKindOf(value));

    if (SchemaAST.isNull(member)) return ["null"];

    if (SchemaAST.isBoolean(member)) return ["boolean"];

    if (SchemaAST.isNumber(member)) return ["number"];

    if (SchemaAST.isString(member) || SchemaAST.isTemplateLiteral(member)) return ["string"];

    if (SchemaAST.isArrays(member)) return ["array"];

    if (SchemaAST.isObjects(member)) return ["object"];

    return jsonKinds;
  });

const jsonOfAcceptedKindOrText = (encoded: SchemaAST.AST) => {
  const accepted = new Set(acceptedJsonKindsOf(encoded));

  return Schema.Union([
    Schema.fromJsonString(Schema.Json).check(
      Schema.makeFilter((json) => accepted.has(jsonKindOf(json))),
    ),
    Schema.String,
  ]);
};

const stringChoicesOf = (ast: SchemaAST.AST): ReadonlyArray<string> | undefined => {
  const accepted = members(ast).flatMap(literalValues);

  return accepted.every(Predicate.isString) ? accepted : undefined;
};

type Kind = Param.ParamKind;

const takesTextAsIs = (encoded: SchemaAST.AST): boolean =>
  stringChoicesOf(encoded) !== undefined ||
  SchemaAST.isString(encoded) ||
  SchemaAST.isTemplateLiteral(encoded);

const valueParam = (kind: Kind, name: string, field: SchemaAST.AST): Param.Param<Kind, unknown> => {
  const encoded = unsuspended(field);

  if (takesTextAsIs(encoded)) {
    const literals = stringChoicesOf(encoded);

    return literals === undefined ? Param.String(kind, name) : Param.Literals(kind, name, literals);
  }

  if (SchemaAST.isBoolean(encoded)) return Param.Boolean(kind, name);

  return Param.String(kind, name).pipe(
    Param.withSchema(jsonOfAcceptedKindOrText(encoded)),
    Param.withMetavar("value"),
  );
};

const withoutOptionalAbsence = (ast: SchemaAST.AST): SchemaAST.AST => {
  const members = SchemaAST.isUnion(ast)
    ? ast.types.filter((member) => !SchemaAST.isNull(member) && !SchemaAST.isUndefined(member))
    : [];

  return members.length === 1 && members[0] !== undefined ? members[0] : ast;
};

const optionalAddedNull = (plain: SchemaAST.AST): boolean => {
  const types = members(plain);

  return types.some(SchemaAST.isUndefined) && !types.some(SchemaAST.isNull);
};

const repeatedElementOf = (
  ast: SchemaAST.AST,
): { readonly element: SchemaAST.AST; readonly min: number } | undefined => {
  const encoded = unsuspended(ast);

  if (!SchemaAST.isArrays(encoded)) return undefined;

  const [element, ...after] = encoded.rest;

  if (
    element === undefined ||
    after.length > 0 ||
    !encoded.elements.every((first) => first === element) ||
    !acceptedJsonKindsOf(element).every((kind) => kind === "string" || kind === "number")
  ) {
    return undefined;
  }

  return { element, min: encoded.elements.length };
};

// Why: An occurrence of `[]` adding no element is how a repeated flag sends an empty list.
// Rejected: an occurrence holding a whole JSON array, which a choice's flag cannot take, since
// `Param.variadic` repeats one parameter and `Param.orElse` makes two.
const noElementOccurrence = "[]";

// Why: The help of Effect CLI shows a flag's name and the kind of its value, which say neither that
// a flag repeats, nor that `--no-<flag>` is a switch's `false`, nor that a value is JSON. A switch
// of a required field is `false` when left out, which its help says; an optional one is left
// out when left out, so its help says how to send `false`.
const jsonHintOf = (encoded: SchemaAST.AST): string | undefined => {
  const value = unsuspended(encoded);
  const kinds = new Set(acceptedJsonKindsOf(value));

  if (kinds.size !== 1) return undefined;

  if (kinds.has("object")) return "A JSON object.";

  if (!kinds.has("array")) return undefined;

  const fields = elementFieldsOf(value);

  return fields === undefined ? "A JSON array." : `A JSON array of {${fields.join(", ")}}.`;
};

const elementFieldsOf = (array: SchemaAST.AST): ReadonlyArray<string> | undefined => {
  if (!SchemaAST.isArrays(array)) return undefined;

  const [element, ...others] = [...array.elements, ...array.rest];

  if (element === undefined || others.some((other) => other !== element)) return undefined;

  const fields = namedFieldsOf(unsuspended(element));

  return fields.size === 0
    ? undefined
    : Array.from(fields, ([name, field]) =>
        SchemaAST.isOptional(field) ? `${String(name)}?` : String(name),
      );
};

const withHint = (description: string | undefined, hint: string | undefined) => {
  if (hint === undefined || description === undefined) return description ?? hint;

  const stated = description.trimEnd();

  return /[.!?:]$/.test(stated) ? `${stated} ${hint}` : `${stated}. ${hint}`;
};

const fieldParam = (
  kind: Kind,
  name: string,
  encoded: SchemaAST.AST,
  plain: SchemaAST.AST | undefined,
): Pick<FieldParam, "param" | "repeats" | "hint"> => {
  const optional = SchemaAST.isOptional(encoded);

  const value =
    optional && plain !== undefined && optionalAddedNull(plain)
      ? withoutOptionalAbsence(encoded)
      : encoded;

  const repeats = repeatedElementOf(value);

  if (repeats !== undefined) {
    const literals = stringChoicesOf(unsuspended(repeats.element));

    const elements =
      literals === undefined
        ? valueParam(kind, name, repeats.element)
        : Param.Literals(kind, name, [...literals, noElementOccurrence]);

    const listed = (values: ReadonlyArray<unknown>) =>
      Option.some(values.filter((value) => value !== noElementOccurrence));

    return {
      param: optional
        ? Param.variadic(elements).pipe(
            Param.map((values) => (values.length === 0 ? Option.none() : listed(values))),
          )
        : Param.variadic(elements, { min: repeats.min }).pipe(Param.map(listed)),
      repeats: true,
      hint: kind === Param.flagKind ? "Repeat for each value." : undefined,
    };
  }

  if (optional) {
    return {
      param: Param.optional(valueParam(kind, name, value)),
      repeats: false,
      hint:
        kind === Param.flagKind && SchemaAST.isBoolean(unsuspended(value))
          ? `--no-${name} sends false.`
          : jsonHintOf(value),
    };
  }

  const isSwitch = kind === Param.flagKind && SchemaAST.isBoolean(unsuspended(encoded));

  return {
    param: isSwitch
      ? Flag.Boolean(name).pipe(Flag.withDefault(false), Flag.map(Option.some))
      : valueParam(kind, name, encoded).pipe(Param.map(Option.some)),
    repeats: false,
    hint: isSwitch ? "Left out, it sends false." : jsonHintOf(encoded),
  };
};

interface FieldParam {
  readonly field: string;
  readonly param: Param.Param<Kind, Option.Option<unknown>>;
  readonly optional: boolean;
  readonly repeats: boolean;
  readonly hint: string | undefined;
  readonly description: string | undefined;
}

type Parsed = Readonly<Record<string, Option.Option<unknown>>>;

const namedFieldsOf = (ast: SchemaAST.AST): ReadonlyMap<PropertyKey, SchemaAST.AST> => {
  const fields = SchemaAST.isDeclaration(ast) ? ast.typeParameters[0] : ast;

  return new Map(
    fields !== undefined && SchemaAST.isObjects(fields)
      ? fields.propertySignatures.map((property) => [property.name, property.type])
      : [],
  );
};

const isTransformedAsWhole = (ast: SchemaAST.AST): boolean =>
  (SchemaAST.isDeclaration(ast) ? ast.typeParameters[0] : ast)?.encoding !== undefined;

// Why: Effect resolves a description from the last check alone, once a schema has checks. One
// annotated before a check is on the schema or on an earlier check, where a tool's listing reads
// it for a model: a flag's help reads it there too, so one description serves both. A field
// decoded from another type is read on its decoded side, then on the encoded one, which is the
// side a tool lists. Where both a schema and a later check are described, help shows the later;
// a description of the field's key, written with `annotateKey`, comes before both, and a
// repeated flag with none of its own shows its element's, which each value given is: read on
// either side whatever the element decodes to, since the encoded side alone says it repeats.
const ownOrSuspendedDescriptionOf = (ast: SchemaAST.AST): string | undefined =>
  ast.context?.annotations?.description ??
  SchemaAST.resolveDescription(ast) ??
  describedBeforeLastCheck(ast) ??
  (SchemaAST.isSuspend(ast) ? ownOrSuspendedDescriptionOf(ast.thunk()) : undefined);

const describedBeforeLastCheck = (ast: SchemaAST.AST): string | undefined =>
  [ast.annotations, ...(ast.checks ?? []).map((check) => check.annotations)]
    .map((annotations) => annotations?.["description"])
    .findLast(Predicate.isString);

const describedThroughAbsence = (ast: SchemaAST.AST): string | undefined =>
  ownOrSuspendedDescriptionOf(ast) ?? ownOrSuspendedDescriptionOf(withoutOptionalAbsence(ast));

const describedByElement = (ast: SchemaAST.AST): string | undefined => {
  const array = unsuspended(withoutOptionalAbsence(ast));
  const element = SchemaAST.isArrays(array) ? array.rest[0] : undefined;

  return element === undefined ? undefined : describedThroughAbsence(element);
};

const fieldParams = (
  encoded: SchemaAST.Objects,
  input: SchemaAST.AST,
  positional: ReadonlyArray<string>,
  aliases: Readonly<Record<string, string | undefined>>,
): ReadonlyArray<FieldParam> => {
  const plainEncodedFields = namedFieldsOf(SchemaAST.toEncoded(input));

  const declaredFieldsUnlessRenamed = namedFieldsOf(
    isTransformedAsWhole(input) ? encoded : SchemaAST.toType(input),
  );

  return encoded.propertySignatures.map((property) => {
    const field = String(property.name);
    const declaredField = declaredFieldsUnlessRenamed.get(property.name);
    const kind = positional.includes(field) ? Param.argumentKind : Param.flagKind;

    const { param, repeats, hint } = fieldParam(
      kind,
      kebab(field),
      property.type,
      plainEncodedFields.get(property.name),
    );

    const alias = kind === Param.flagKind ? aliases[field] : undefined;
    const aliased = alias === undefined ? param : Param.withAlias(param, alias);
    const documented = declaredField ?? property.type;

    const description =
      describedThroughAbsence(documented) ??
      describedThroughAbsence(property.type) ??
      (repeats ? (describedByElement(documented) ?? describedByElement(property.type)) : undefined);

    const help = withHint(description, hint);

    return {
      field,
      param: help === undefined ? aliased : Param.withDescription(aliased, help),
      optional: SchemaAST.isOptional(property.type),
      repeats,
      hint,
      description,
    };
  });
};

const positionalOrder = (
  params: ReadonlyArray<FieldParam>,
  positional: ReadonlyArray<string>,
): ReadonlyArray<FieldParam> => {
  assertDistinct("positional argument", positional, (field) => field, {
    fix: "list each field once",
  });

  const ordered = positional.map((field) => {
    const found = params.find((param) => param.field === field);

    if (found === undefined) {
      throw new Error(
        `Not an input field: ${field} (positional names fields of the action's input)`,
      );
    }

    return found;
  });

  const firstOptional = ordered.findIndex((param) => param.optional);
  const late = ordered.slice(firstOptional === -1 ? ordered.length : firstOptional);
  const misplaced = late.find((param) => !param.optional);

  if (misplaced !== undefined) {
    throw new Error(
      `Required positional argument after an optional one: ${misplaced.field} (list every required field first)`,
    );
  }

  const repeatedBeforeLast = ordered.slice(0, -1).find((param) => param.repeats);

  if (repeatedBeforeLast !== undefined) {
    throw new Error(
      `Repeated positional argument before another one: ${repeatedBeforeLast.field} (list an array field last)`,
    );
  }

  return ordered;
};

const wholeInputFlag = (encoded: SchemaAST.AST) =>
  Flag.String("input").pipe(
    Flag.withSchema(jsonOfAcceptedKindOrText(encoded)),
    Flag.withDescription("Whole action input as JSON; omitted, {}"),
    Flag.optional,
  );

const printedOutput = <A extends Action.Any>(
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
 * What a command fails with when its action fails: Effect CLI's `UserError`, typed with the
 * action's failure as its `cause` and `reason`, and whose `userMessage` is its JSON, or for a
 * failure no schema encodes, as `command` says. A type only.
 *
 * **Gotchas**
 *
 * - `Command.run` has printed it before a recovery runs, so a recovery decides what follows, such as the exit code, not the text: for text of your own, provide `CliOutput.layer(Object.assign({}, CliOutput.defaultFormatter(), { formatError }))`, or pass `renderErrors: false` to `Command.run` and print every failure, the parser's too.
 * - A run also fails with Effect CLI's own errors, such as a flag that does not parse, and only a `UserError` has a `userMessage`: match `Effect.catchTag("UserError", …)` before reading one.
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

const ownStringProperty = <E>(error: E, key: "_tag" | "message"): string | undefined => {
  if (!Predicate.hasProperty(error, key)) return undefined;

  const value = error[key];

  return Predicate.isString(value) ? value : undefined;
};

const describedWithoutFields = <E>(error: E, seen: Set<unknown> = new Set()): string => {
  const name = ownStringProperty(error, "_tag") ?? (error instanceof Error ? error.name : "Error");
  const message = Predicate.isString(error) ? error : (ownStringProperty(error, "message") ?? "");
  const named = message === "" ? name : `${name}: ${message}`;

  seen.add(error);

  return Predicate.hasProperty(error, "cause") &&
    error.cause !== undefined &&
    !seen.has(error.cause)
    ? `${named}: ${describedWithoutFields(error.cause, seen)}`
    : named;
};

const userErrorOf = (errors: Action.Errors) => {
  const encode = Schema.encodeUnknownEffect(
    Schema.fromJsonString(Schema.toCodecJson(Schema.Union(errors))),
  );

  // Why: The schema that holds every field of the failure, before the first that accepts it. A
  // command of your own prints the failure of any action it calls, and one action's error may
  // accept another's while dropping the fields it does not declare.
  return <E>(error: E) =>
    encode(error, { onExcessProperty: "error" }).pipe(
      Effect.catch(() => encode(error)),
      Effect.orElseSucceed(() => describedWithoutFields(error)),
      Effect.flatMap((userMessage) => Effect.fail(new UserError<E>({ cause: error, userMessage }))),
    );
};

// Why: An Effect CLI error, a `CliError.UserError` of your own included, passes through as it is,
// in a derived command as in one of your own: described again, it would print its cause beside
// its `userMessage`.
export const failingAsDerived = (errors: Action.Errors) => {
  const failure = userErrorOf(errorSchemas(errors));

  return <A, E, R>(self: Effect.Effect<A, E, R>) =>
    Effect.catchIf(
      self,
      (error): error is Exclude<E, CliError.CliError> => !CliError.isCliError(error),
      failure,
    );
};

const unreadableStdinField = (field: string, message: string) =>
  new InvalidInput({ message, issues: [{ path: [field], message }] });

const fieldValueFromText = (field: SchemaAST.AST): ((text: string) => Schema.Json) => {
  const encoded = unsuspended(field);

  return takesTextAsIs(encoded)
    ? (text) => text
    : Schema.decodeSync(jsonOfAcceptedKindOrText(encoded));
};

const stdinTextOf = (field: string) =>
  Effect.gen(function* () {
    // Why: Read as an option, not required. `Stdio` is in the environment `Command.run` requires of
    // its host, so every run has it, and requiring it here would add it to the type of every
    // derived command, with `stdin` or without.
    const stdio = yield* Effect.serviceOption(Stdio.Stdio);

    if (Option.isNone(stdio))
      return yield* Effect.die(
        new Error(
          "Stdio is not provided (provide NodeServices.layer, or Stdio.layerTest in a test)",
        ),
      );

    if (yield* stdio.value.stdinIsTerminal) {
      return yield* unreadableStdinField(
        field,
        `${field} is read from stdin, which is a terminal: pipe it in`,
      );
    }

    const text = yield* stdio.value.stdin.pipe(
      Stream.decodeText(),
      Stream.mkString,
      Effect.mapError((error) =>
        unreadableStdinField(field, `stdin cannot be read: ${error.message}`),
      ),
    );

    return text.replace(/[\r\n]+$/, "");
  });

interface InputConfig<A extends Action.Any> {
  readonly flags: Readonly<Record<string, Param.Param<Kind, Option.Option<unknown>>>>;
  readonly positional: ReadonlyArray<FieldParam>;
  readonly decode: (parsed: Parsed) => Effect.Effect<A["input"]["Type"], InvalidInput>;
  readonly stdinHelp: string | undefined;
}

const inputConfig = <A extends Action.Any>(
  action: A,
  positional: ReadonlyArray<string>,
  aliases: Readonly<Record<string, string | undefined>>,
  stdin: string | undefined,
): InputConfig<A> => {
  const codec = Schema.toCodecJson(action.input);
  const encoded = unsuspended(SchemaAST.toEncoded(codec.ast));
  const decode = decodeInput(action);

  const isStructOfNamedFields =
    SchemaAST.isObjects(encoded) &&
    encoded.indexSignatures.every((signature) => SchemaAST.isNever(signature.type));

  if (isStructOfNamedFields) {
    const params = fieldParams(encoded, unsuspended(action.input.ast), positional, aliases);

    const fromStdin = Option.map(Option.fromUndefinedOr(stdin), (field) => {
      const property = encoded.propertySignatures.find(({ name }) => name === field);

      if (property === undefined || SchemaAST.isOptional(property.type)) {
        throw new Error(
          `Not a required input field: ${field} (stdin names a required field of the action's input)`,
        );
      }

      if (positional.includes(field)) {
        throw new Error(`Both positional and stdin: ${field} (take it from one of them)`);
      }

      const description = params.find((param) => param.field === field)?.description;

      return {
        field,
        value: fieldValueFromText(property.type),
        help: `Reads ${kebab(field)} from stdin${description === undefined ? "." : `: ${description}`}`,
      };
    });

    const flagged = new Set(
      params
        .map(({ field }) => field)
        .filter((field) => !positional.includes(field) && field !== stdin),
    );

    const stray = Object.keys(aliases).find((field) => !flagged.has(field));

    if (stray !== undefined) {
      throw new Error(
        `Not a flag's input field: ${stray} (aliases name fields read from flags, neither positional nor stdin)`,
      );
    }

    return {
      flags: Object.fromEntries(
        params.flatMap(({ field, param }) => (flagged.has(field) ? [[field, param]] : [])),
      ),
      positional: positionalOrder(params, positional),
      decode: (parsed) =>
        Option.match(fromStdin, {
          onNone: () => decode(Record.getSomes(parsed)),
          onSome: ({ field, value }) =>
            Effect.flatMap(stdinTextOf(field), (text) =>
              decode({ ...Record.getSomes(parsed), [field]: value(text) }),
            ),
        }),
      stdinHelp: Option.getOrUndefined(Option.map(fromStdin, ({ help }) => help)),
    };
  }

  const asWhole = "(the input is not a struct, so it is one --input flag: drop the option)";

  if (positional.length > 0) {
    throw new Error(
      `Positional arguments need named input fields: ${positional.join(", ")} ${asWhole}`,
    );
  }

  if (Object.keys(aliases).length > 0) {
    throw new Error(
      `Aliases need named input fields: ${Object.keys(aliases).join(", ")} ${asWhole}`,
    );
  }

  if (stdin !== undefined) throw new Error(`Stdin needs named input fields: ${stdin} ${asWhole}`);

  return {
    flags: { input: wholeInputFlag(encoded) },
    positional: [],
    decode: (parsed) => decode(Option.getOrElse(parsed["input"] ?? Option.none(), () => ({}))),
    stdinHelp: undefined,
  };
};

// Why: Effect CLI keys a field's flag and an alias alike, by bare name, and prints a
// one-character alias as `-n`, every other flag as `--name`.
const aliasFlag = (alias: string) => (alias.length === 1 ? `-${alias}` : `--${alias}`);

export const command = <A extends Action.Any, E, R>(
  action: A,
  execute: (input: A["input"]["Type"]) => Effect.Effect<A["success"]["Type"], E, R>,
  options: Options<A> | undefined,
  errors: Action.Errors,
) => {
  const name = options?.name ?? kebab(action.name);
  const description = options?.description ?? action.description;
  const render = options?.render;

  const { flags, positional, decode, stdinHelp } = inputConfig(
    action,
    options?.positional ?? [],
    options?.aliases ?? {},
    options?.stdin,
  );

  const failing = failingAsDerived(errors);

  assertDistinct(
    "flag",
    [
      ...Object.keys(flags).map(
        (field) => [kebab(field), `--${kebab(field)}`, `field ${field}`] as const,
      ),
      ...(render === undefined ? [] : [["json", "--json", "render's --json"] as const]),
      ...Object.entries(options?.aliases ?? {}).flatMap(([field, alias]) => {
        const bare = Predicate.isString(alias) ? alias.replace(/^-+/, "") : undefined;

        return bare === undefined
          ? []
          : [[bare, aliasFlag(bare), `alias of field ${field}`] as const];
      }),
    ],
    ([key]) => key,
    {
      labelOf: ([, label]) => label,
      claimantOf: ([, , claimant]) => claimant,
      fix:
        render === undefined
          ? "rename the field or the alias"
          : "rename the field or the alias, or drop `render`",
    },
  );

  const args = positional.map(({ param }) => param);

  const parsedFields = (input: Parsed, values: ReadonlyArray<Option.Option<unknown>>) => ({
    ...input,
    ...Object.fromEntries(
      positional.map(({ field }, index) => [field, values[index] ?? Option.none()] as const),
    ),
  });

  const run = (parsed: Parsed, rendered: ((output: A["success"]["Type"]) => string) | undefined) =>
    decode(parsed).pipe(
      Effect.flatMap(execute),
      failing,
      Effect.flatMap((value) => printedOutput(action, value, rendered)),
      withStderrConsole,
      Effect.flatMap(Option.match({ onNone: () => Effect.void, onSome: Console.log })),
    );

  const command =
    render === undefined
      ? Command.make(name, { input: flags, args }, ({ input, args: values }) =>
          run(parsedFields(input, values), undefined),
        )
      : Command.make(
          name,
          { input: flags, args, json: renderedCommandJsonFlag },
          ({ input, args: values, json }) =>
            run(parsedFields(input, values), json ? undefined : render),
        );

  return stdinHelp === undefined
    ? Command.withDescription(command, description)
    : command.pipe(
        Command.withDescription(`${description}\n\n${stdinHelp}`),
        Command.withShortDescription(description),
      );
};
