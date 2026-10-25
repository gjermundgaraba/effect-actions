import { Predicate, Schema, SchemaAST } from "effect";
import { McpProtocol, type McpSchema } from "effect/ai";
import { Base64 } from "effect/encoding";
import type * as Action from "../contract/Action.js";
import type { ErasedValue } from "../contract/implementation.js";
import { isMarked, type Kind, kindOf, Media } from "../contract/media.js";
import { unsuspended } from "../contract/ast.js";

// Why: The stateless revision is the one a request written without a handshake speaks, as
// `request` writes it, and the one whose routing headers the runtime checks against the
// body, which a mixed endpoint's gate relies on.
export const httpProtocol = McpProtocol.v2026_07_28;

// Why: Hosts such as Claude Code and Codex open stdio with `initialize`, and Codex opens HTTP with
// it too, which only the two stateful revisions answer. HTTP served the stateless one alone, as a
// session lasts until its client ends it and Effect's runtime expires none; that left such a host
// no way to a hosted endpoint, so it is reversed. A session holds its client's `initialize`
// payload and no identity: every request authenticates as before, and where an endpoint serves a
// protected tool, only a signed-in caller opens one. The revisions before these stay out: Effect's
// adapters for them list an input's `type`, `properties` and `required` alone, so a `$ref` to its
// definitions resolves nowhere.
export const protocols = [
  McpProtocol.v2026_07_28,
  McpProtocol.v2025_11_25,
  McpProtocol.v2025_06_18,
] as const;

export const defaultPath = "/mcp";

/** The forms an MCP routing header may carry `name` in: as sent, or base64-encoded in its sentinel. */
export const routingFormsOf = (name: string): ReadonlyArray<string> => [
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
  readonly fields: ReadonlyArray<Field>;
  readonly rest: Codec | undefined;
}

const kindOfUnsuspended = (ast: SchemaAST.AST) => kindOf(unsuspended(ast));

const wholeSuccessMediaOf = (suspended: SchemaAST.AST) => {
  const ast = unsuspended(suspended);
  const one = kindOf(ast);

  if (one !== undefined) return { kind: one, many: false };

  if (!SchemaAST.isArrays(ast) || ast.encoding !== undefined) return undefined;

  const [kind, ...others] = new Set([...ast.elements, ...ast.rest].map(kindOfUnsuspended));

  return kind === undefined || others.length > 0 ? undefined : { kind, many: true };
};

const mediaFieldOf = (field: SchemaAST.AST) => {
  const optional = field.context?.isOptional === true;
  const ast = unsuspended(field);

  if (optional && SchemaAST.isUnion(ast) && ast.types.length === 2) {
    const [definedMember, ...otherDefinedMembers] = ast.types.filter(
      (member) => !SchemaAST.isUndefined(member),
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

  if (whole !== undefined) return { fields: [{ name: undefined, ...whole }], rest: undefined };

  if (!SchemaAST.isObjects(ast) || ast.encoding !== undefined) return { fields: [], rest: success };

  const fields = ast.propertySignatures.flatMap(({ name, type }) => {
    const field = mediaFieldOf(type);

    return field === undefined ? [] : [{ name: String(name), ...field }];
  });

  if (fields.length === 0) return { fields, rest: success };

  const names = new Set<PropertyKey>(fields.map(({ name }) => name));
  const rest = ast.propertySignatures.filter(({ name }) => !names.has(name));

  const { identifier: _identifierOfWholeSuccess, ...annotationsOfRest } = ast.annotations ?? {};

  return {
    fields,
    rest:
      rest.length === 0 && ast.indexSignatures.length === 0
        ? undefined
        : Schema.make<Codec>(new SchemaAST.Objects(rest, ast.indexSignatures, annotationsOfRest)),
  };
};

const partsAndEncodedSideOf = (ast: SchemaAST.AST): ReadonlyArray<SchemaAST.AST> => [
  ...(SchemaAST.isDeclaration(ast) ? ast.typeParameters : []),
  ...(SchemaAST.isArrays(ast) ? [...ast.elements, ...ast.rest] : []),
  ...(SchemaAST.isObjects(ast)
    ? [...ast.propertySignatures, ...ast.indexSignatures].map(({ type }) => type)
    : []),
  ...(SchemaAST.isUnion(ast) ? ast.types : []),
  ...(SchemaAST.isSuspend(ast) ? [ast.thunk()] : []),
  ...(ast.encoding ?? []).map(({ to }) => to),
];

const holdsMediaAnywhere = (ast: SchemaAST.AST): boolean => {
  const seen = new Set<SchemaAST.AST>();
  const pending = [ast];

  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    if (seen.has(next)) continue;

    seen.add(next);

    if (isMarked(next)) return true;

    pending.push(...partsAndEncodedSideOf(next));
  }

  return false;
};

export const isMisplaced = (action: Action.Any, { rest }: Lift): boolean => {
  return [action.input, ...action.error, ...(rest === undefined ? [] : [rest])].some(({ ast }) =>
    holdsMediaAnywhere(ast),
  );
};

export interface Lifted {
  readonly kind: Kind;
  readonly field: string | undefined;
  readonly value: typeof Media.Type;
}

export const liftedFrom = (lift: Lift, success: ErasedValue): ReadonlyArray<Lifted> =>
  lift.fields.flatMap(({ name, kind, many }) => {
    const value =
      name === undefined
        ? success
        : Predicate.hasProperty(success, name)
          ? success[name]
          : undefined;

    const values = many ? (isMediaArray(value) ? value : []) : isMedia(value) ? [value] : [];

    return values.map((media) => ({ kind, field: name, value: media }));
  });

const mediaOf = ({ name, kind, many }: Field, result: McpSchema.CallToolResult) => {
  const values = result.content.flatMap((block) =>
    block.type === kind && block._meta?.[fieldKey] === name
      ? [{ data: Base64.encode(block.data), mimeType: block.mimeType }]
      : [],
  );

  return many || values.length > 1 ? values : values[0];
};

/**
 * The encoded success a tool result carries, `liftedFrom` undone: its structured content, each
 * lifted field from the blocks whose `_meta` names it, and a success that is media from its
 * blocks alone.
 */
export const unliftedFrom = (lift: Lift, result: McpSchema.CallToolResult) => {
  const [whole] = lift.fields;

  if (whole !== undefined && whole.name === undefined) return mediaOf(whole, result);

  const { structuredContent = {} } = result;

  if (!Predicate.isObject(structuredContent)) return structuredContent;

  const lifted = new Set(lift.fields.map(({ name }) => name));

  return Object.fromEntries([
    ...Object.entries(structuredContent).filter(([key]) => !lifted.has(key)),
    ...lift.fields.flatMap((field) => {
      const value = mediaOf(field, result);

      return field.name === undefined || value === undefined ? [] : [[field.name, value] as const];
    }),
  ]);
};
