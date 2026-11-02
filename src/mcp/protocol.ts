import { JsonPointer, Predicate, Schema, SchemaAST } from "effect";
import type { JsonSchema } from "effect";
import { McpProtocol, McpSchema } from "effect/ai";
import { Base64 } from "effect/encoding";

import type * as Action from "../contract/Action.js";
import type { Field, Lift } from "../contract/lift.js";
import { isMarked } from "../contract/media.js";

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

const definitionReferenced = (
  schema: JsonSchema.JsonSchema
): string | undefined => {
  const [scope, key] = Predicate.isString(schema["$ref"])
    ? (JsonPointer.parseUriFragment(schema["$ref"]) ?? [])
    : [];

  return scope === "$defs" && key !== undefined ? key : undefined;
};

const inlineRoot = (
  schema: JsonSchema.JsonSchema | undefined,
  definitions: JsonSchema.Definitions,
  inlined: readonly string[]
): readonly [JsonSchema.JsonSchema | undefined, readonly string[]] => {
  const key = schema === undefined ? undefined : definitionReferenced(schema);

  if (key === undefined) {
    return [schema, inlined];
  }

  return inlined.includes(key)
    ? [undefined, inlined]
    : inlineRoot(definitions[key], definitions, [...inlined, key]);
};

const withoutUnreferenced = (
  root: JsonSchema.JsonSchema,
  definitions: JsonSchema.Definitions,
  inlined: readonly string[]
): JsonSchema.Definitions => {
  const referenced = new Set(
    [root, ...Object.values(definitions)].flatMap((definition) =>
      isJson(definition) ? definitionsReferenced(definition) : []
    )
  );

  const unreferenced = inlined.filter(
    (name) => Object.hasOwn(definitions, name) && !referenced.has(name)
  );

  return unreferenced.length === 0
    ? definitions
    : withoutUnreferenced(
        root,
        Object.fromEntries(
          Object.entries(definitions).filter(
            ([name]) => !unreferenced.includes(name)
          )
        ),
        inlined
      );
};

export const toolJsonSchema = (
  schema: Schema.Top,
  strict: boolean
): JsonSchema.JsonSchema | undefined => {
  const document = Schema.toJsonSchemaDocument(schema, {
    onExcessProperty: strict ? "error" : "ignore",
  });

  const [root, inlined] = inlineRoot(document.schema, document.definitions, []);

  if (root === undefined) {
    return undefined;
  }

  const definitions = withoutUnreferenced(root, document.definitions, inlined);

  return Object.keys(definitions).length === 0
    ? root
    : { ...root, $defs: definitions };
};

export const fieldKey = "effect-actions/field";

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
