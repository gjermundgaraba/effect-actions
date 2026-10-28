import { JsonPointer, Predicate, Schema, SchemaAST } from "effect";
import type { JsonSchema } from "effect";
import { McpProtocol, McpSchema } from "effect/ai";
import { Base64 } from "effect/encoding";

import type * as Action from "../contract/Action.js";
import { unsuspended } from "../contract/ast.js";
import type { ErasedValue } from "../contract/implementation.js";
import { isMarked, kindOf, Media } from "../contract/media.js";
import type { Kind } from "../contract/media.js";

export const httpProtocol = McpProtocol.v2026_07_28;

export const protocols = [
  McpProtocol.v2026_07_28,
  McpProtocol.v2025_11_25,
  McpProtocol.v2025_06_18,
] as const;

export const defaultPath = "/mcp";

export const isObjectSchema = Schema.is(McpSchema.ToolJson);

const isJson = Schema.is(Schema.Json);

const definitionsReferenced = (value: Schema.Json): readonly string[] => {
  if (
    value === null ||
    Predicate.isString(value) ||
    Predicate.isNumber(value) ||
    Predicate.isBoolean(value)
  ) {
    return [];
  }

  if (Array.isArray(value)) {
    return value.flatMap(definitionsReferenced);
  }

  return Object.entries(value).flatMap(([field, nested]) => {
    if (field !== "$ref") {
      return definitionsReferenced(nested);
    }

    const [scope, key] = Predicate.isString(nested)
      ? (JsonPointer.parseUriFragment(nested) ?? [])
      : [];

    return scope === "$defs" && key !== undefined ? [key] : [];
  });
};

export const toolJsonSchema = (
  schema: Schema.Top,
  strict: boolean
): JsonSchema.JsonSchema | undefined => {
  const document = Schema.toJsonSchemaDocument(schema, {
    onExcessProperty: strict ? "error" : "ignore",
  });

  const [scope, key] = Predicate.isString(document.schema["$ref"])
    ? (JsonPointer.parseUriFragment(document.schema["$ref"]) ?? [])
    : [];

  const inlined = scope === "$defs" && key !== undefined ? key : undefined;

  const root =
    inlined === undefined ? document.schema : document.definitions[inlined];

  if (root === undefined) {
    return undefined;
  }

  const definitions =
    inlined !== undefined &&
    ![root, ...Object.values(document.definitions)]
      .flatMap((definition) =>
        isJson(definition) ? definitionsReferenced(definition) : []
      )
      .includes(inlined)
      ? Object.fromEntries(
          Object.entries(document.definitions).filter(
            ([name]) => name !== inlined
          )
        )
      : document.definitions;

  return Object.keys(definitions).length === 0
    ? root
    : { ...root, $defs: definitions };
};

export const routingFormsOf = (name: string): readonly string[] => [
  name,
  `=?base64?${Base64.encode(name)}?=`,
];

type Codec = Action.Any["success"];

export const fieldKey = "effect-actions/field";

const isMedia = Schema.is(Media);

const isMediaArray = Schema.is(Schema.Array(Media));

interface Field {
  readonly name: string | undefined;
  readonly kind: Kind;
  readonly many: boolean;
}

export interface Lift {
  readonly fields: readonly Field[];
  readonly rest: Codec | undefined;
}

const kindOfUnsuspended = (ast: SchemaAST.AST) => kindOf(unsuspended(ast));

const wholeSuccessMediaOf = (suspended: SchemaAST.AST) => {
  const ast = unsuspended(suspended);
  const one = kindOf(ast);

  if (one !== undefined) {
    return { kind: one, many: false };
  }

  if (!SchemaAST.isArrays(ast) || ast.encoding !== undefined) {
    return;
  }

  const [kind, ...others] = new Set(
    [...ast.elements, ...ast.rest].map(kindOfUnsuspended)
  );

  return kind === undefined || others.length > 0
    ? undefined
    : { kind, many: true };
};

const mediaFieldOf = (field: SchemaAST.AST) => {
  const optional = field.context?.isOptional === true;
  const ast = unsuspended(field);

  if (optional && SchemaAST.isUnion(ast) && ast.types.length === 2) {
    const [definedMember, ...otherDefinedMembers] = ast.types.filter(
      (member) => !SchemaAST.isUndefined(member)
    );

    const kind =
      definedMember === undefined || otherDefinedMembers.length > 0
        ? undefined
        : kindOfUnsuspended(definedMember);

    return kind === undefined ? undefined : { kind, many: false };
  }

  const whole = wholeSuccessMediaOf(ast);

  return whole === undefined || (optional && whole.many) ? undefined : whole;
};

export const liftOf = (success: Codec): Lift => {
  const ast = unsuspended(success.ast);
  const whole = wholeSuccessMediaOf(ast);

  if (whole !== undefined) {
    return { fields: [{ name: undefined, ...whole }], rest: undefined };
  }

  if (!SchemaAST.isObjects(ast) || ast.encoding !== undefined) {
    return { fields: [], rest: success };
  }

  const fields = ast.propertySignatures.flatMap(({ name, type }) => {
    const field = mediaFieldOf(type);

    return field === undefined ? [] : [{ name: String(name), ...field }];
  });

  if (fields.length === 0) {
    return { fields, rest: success };
  }

  const names = new Set<PropertyKey>(fields.map(({ name }) => name));
  const rest = ast.propertySignatures.filter(({ name }) => !names.has(name));

  const { identifier: _identifierOfWholeSuccess, ...annotationsOfRest } =
    ast.annotations ?? {};

  return {
    fields,
    rest:
      rest.length === 0 && ast.indexSignatures.length === 0
        ? undefined
        : Schema.make<Codec>(
            new SchemaAST.Objects(rest, ast.indexSignatures, annotationsOfRest)
          ),
  };
};

const partsAndEncodedSideOf = (
  ast: SchemaAST.AST
): readonly SchemaAST.AST[] => [
  ...(SchemaAST.isDeclaration(ast) ? ast.typeParameters : []),
  ...(SchemaAST.isArrays(ast) ? [...ast.elements, ...ast.rest] : []),
  ...(SchemaAST.isObjects(ast)
    ? [...ast.propertySignatures, ...ast.indexSignatures].map(
        ({ type }) => type
      )
    : []),
  ...(SchemaAST.isUnion(ast) ? ast.types : []),
  ...(SchemaAST.isSuspend(ast) ? [ast.thunk()] : []),
  ...(ast.encoding ?? []).map(({ to }) => to),
];

const holdsMediaAnywhere = (ast: SchemaAST.AST): boolean => {
  const seen = new Set<SchemaAST.AST>();
  const pending = [ast];

  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    if (seen.has(next)) {
      continue;
    }

    seen.add(next);

    if (isMarked(next)) {
      return true;
    }

    pending.push(...partsAndEncodedSideOf(next));
  }

  return false;
};

export const isMisplaced = (action: Action.Any, { rest }: Lift): boolean =>
  [action.input, ...action.error, ...(rest === undefined ? [] : [rest])].some(
    ({ ast }) => holdsMediaAnywhere(ast)
  );

export interface Lifted {
  readonly kind: Kind;
  readonly field: string | undefined;
  readonly value: typeof Media.Type;
}

export const liftedFrom = (
  lift: Lift,
  success: ErasedValue
): readonly Lifted[] =>
  lift.fields.flatMap(({ name, kind, many }) => {
    const field =
      name !== undefined && Predicate.hasProperty(success, name)
        ? success[name]
        : undefined;

    const value = name === undefined ? success : field;
    const listed = isMediaArray(value) ? value : [];
    const single = isMedia(value) ? [value] : [];

    return (many ? listed : single).map((media) => ({
      kind,
      field: name,
      value: media,
    }));
  });

const mediaOf = (
  { name, kind, many }: Field,
  result: McpSchema.CallToolResult
) => {
  const values = result.content.flatMap((block) =>
    block.type === kind && block._meta?.[fieldKey] === name
      ? [{ data: Base64.encode(block.data), mimeType: block.mimeType }]
      : []
  );

  return many || values.length > 1 ? values : values[0];
};

export const unliftedFrom = (lift: Lift, result: McpSchema.CallToolResult) => {
  const [whole] = lift.fields;

  if (whole !== undefined && whole.name === undefined) {
    return mediaOf(whole, result);
  }

  const { structuredContent = {} } = result;

  if (!Predicate.isObject(structuredContent)) {
    return structuredContent;
  }

  const lifted = new Set(lift.fields.map(({ name }) => name));

  return Object.fromEntries([
    ...Object.entries(structuredContent).filter(([key]) => !lifted.has(key)),
    ...lift.fields.flatMap((field) => {
      const value = mediaOf(field, result);

      return field.name === undefined || value === undefined
        ? []
        : [[field.name, value] as const];
    }),
  ]);
};
