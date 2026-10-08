import { Predicate, Schema, SchemaAST } from "effect";
import { McpProtocol } from "effect/ai";
import type * as Action from "../Action.js";
import type { ErasedValue } from "./implementation.js";
import { isMarked, type Kind, kindOf, Media } from "./media.js";

/**
 * The one protocol revision served over HTTP. 2026-07-28 is stateless: every request
 * stands alone. The stateful revisions keep a session per `initialize`, which the native
 * HTTP runtime never expires and which no identity owns. A mixed endpoint's gate relies on it
 * too: it decides from the routing headers, which the native runtime checks against the body
 * of a stateless request alone, so serving a stateful revision over HTTP would open the gate.
 */
export const httpProtocol = McpProtocol.v2026_07_28;

/** Where `ActionMcp.layerHttp` serves, and `Testing.mcpClient` calls, by default. */
export const defaultPath = "/mcp";

/** An MCP request's parameters: JSON, leaving out an `undefined` one, as a caller may. */
export interface Params {
  readonly _meta?: { readonly [key: string]: Schema.Json };
  readonly [key: string]: Schema.Json | undefined;
}

/** The parameter a method's `mcp-name` header repeats, as the native runtime routes it. */
const routed = (method: string, params: Params) =>
  method === "resources/read" ? params.uri : params.name;

/**
 * One stateless MCP request of `method` with `params`, as `ActionMcp.layerHttp` serves it:
 * the headers routing it, which repeat what its body says, and its JSON-RPC body. The client
 * metadata goes in `_meta`, under any given, such as a `progressToken`; the protocol version
 * is always the request's own.
 */
export const statelessRequest = (method: string, params: Params) => {
  const { protocolVersion } = httpProtocol;
  const name = routed(method, params);

  return {
    headers: {
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": protocolVersion,
      "mcp-method": method,
      ...(Predicate.isString(name) ? { "mcp-name": name } : {}),
    },
    body: {
      jsonrpc: "2.0",
      id: 1,
      method,
      params: {
        ...params,
        _meta: {
          "io.modelcontextprotocol/clientCapabilities": {},
          "io.modelcontextprotocol/clientInfo": { name: "effect-actions", version: "0" },
          ...params._meta,
          "io.modelcontextprotocol/protocolVersion": protocolVersion,
        },
      },
    },
  };
};

/** Any service-free schema, as a contract holds its success. */
type Codec = Action.Any["success"];

/** The `_meta` key of a lifted block naming its field. */
export const fieldKey = "effect-actions/field";

const isMedia = Schema.is(Media);

const isMediaArray = Schema.is(Schema.Array(Media));

/**
 * Media an MCP tool lifts: a top-level field of a struct success, by name, or the whole
 * success, none; one value, or an array.
 */
export interface Field {
  readonly name: string | undefined;
  readonly kind: Kind;
  readonly many: boolean;
}

/**
 * How an MCP tool sends a success: the media it lifts, in field order, and the rest, sent as
 * any success is, none when nothing else is left. A success without media is all rest.
 */
export interface Lift {
  readonly fields: ReadonlyArray<Field>;
  readonly rest: Codec | undefined;
}

/** The schema `ast` stands for, a `Schema.suspend` resolved, which only delays its definition. */
const resolved = (ast: SchemaAST.AST): SchemaAST.AST =>
  SchemaAST.isSuspend(ast) ? resolved(ast.thunk()) : ast;

/** The kind `ast` is, suspended or not. */
const kindIn = (ast: SchemaAST.AST) => kindOf(resolved(ast));

/**
 * The media `ast` is, one value or an array of them, as a whole success may be: an array without
 * an encoding of its own whose every element is media of one kind, such as `Schema.Array` or
 * `Schema.NonEmptyArray` of it.
 */
const wholeOf = (suspended: SchemaAST.AST) => {
  const ast = resolved(suspended);
  const one = kindOf(ast);

  if (one !== undefined) return { kind: one, many: false };

  if (!SchemaAST.isArrays(ast) || ast.encoding !== undefined) return undefined;

  const [kind, ...others] = new Set([...ast.elements, ...ast.rest].map(kindIn));

  return kind === undefined || others.length > 0 ? undefined : { kind, many: true };
};

/**
 * The media a field's `ast` is: one value, which `Schema.optional` or `Schema.optionalKey` may
 * make absent, or an array, which they may not, as no block would tell an absent one from an
 * empty one.
 */
const fieldOf = (field: SchemaAST.AST) => {
  const optional = field.context?.isOptional === true;
  const ast = resolved(field);

  // An optional value is a union with `undefined`, in either order.
  if (optional && SchemaAST.isUnion(ast) && ast.types.length === 2) {
    const [value, ...more] = ast.types.filter((member) => !SchemaAST.isUndefined(member));
    const kind = value === undefined || more.length > 0 ? undefined : kindIn(value);

    return kind === undefined ? undefined : { kind, many: false };
  }

  const whole = wholeOf(ast);

  return whole === undefined || (optional && whole.many) ? undefined : whole;
};

/**
 * How an MCP tool sends `success`: it lifts the success itself, one value or an array, or the
 * top-level media fields of a struct without an encoding of its own, keyed by strings, and
 * sends the rest of the struct, if any is left.
 */
export const liftOf = (success: Codec): Lift => {
  const ast = resolved(success.ast);
  const whole = wholeOf(ast);

  if (whole !== undefined) return { fields: [{ name: undefined, ...whole }], rest: undefined };

  if (!SchemaAST.isObjects(ast) || ast.encoding !== undefined) return { fields: [], rest: success };

  // A JSON codec keys an object by strings alone.
  const fields = ast.propertySignatures.flatMap(({ name, type }) => {
    const field = fieldOf(type);

    return field === undefined ? [] : [{ name: String(name), ...field }];
  });

  if (fields.length === 0) return { fields, rest: success };

  const names = new Set<PropertyKey>(fields.map(({ name }) => name));
  const rest = ast.propertySignatures.filter(({ name }) => !names.has(name));

  // The rest keeps the success's description, but not its identifier, which names the whole.
  const { identifier: _identifier, ...annotations } = ast.annotations ?? {};

  return {
    fields,
    rest:
      rest.length === 0 && ast.indexSignatures.length === 0
        ? undefined
        : Schema.make<Codec>(new SchemaAST.Objects(rest, ast.indexSignatures, annotations)),
  };
};

/** The schemas `ast` is made of, its encoded side included. */
const partsOf = (ast: SchemaAST.AST): ReadonlyArray<SchemaAST.AST> => [
  ...(SchemaAST.isDeclaration(ast) ? ast.typeParameters : []),
  ...(SchemaAST.isArrays(ast) ? [...ast.elements, ...ast.rest] : []),
  ...(SchemaAST.isObjects(ast)
    ? [...ast.propertySignatures, ...ast.indexSignatures].map(({ type }) => type)
    : []),
  ...(SchemaAST.isUnion(ast) ? ast.types : []),
  ...(SchemaAST.isSuspend(ast) ? [ast.thunk()] : []),
  ...(ast.encoding ?? []).map(({ to }) => to),
];

/** Whether `ast` holds media anywhere, each schema visited once, so a recursive one ends. */
const holdsMedia = (ast: SchemaAST.AST): boolean => {
  const seen = new Set<SchemaAST.AST>();
  const pending = [ast];

  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    if (seen.has(next)) continue;

    seen.add(next);

    if (isMarked(next)) return true;

    pending.push(...partsOf(next));
  }

  return false;
};

/**
 * Whether `action`, whose success an MCP tool lifts as `lift` says, holds media where no tool
 * lifts it: in its input, in a declared error, or in the rest of its success, such as nested in
 * a field or in a union.
 */
export const isMisplaced = (action: Action.Any, { rest }: Lift): boolean => {
  return [action.input, ...action.error, ...(rest === undefined ? [] : [rest])].some(({ ast }) =>
    holdsMedia(ast),
  );
};

/** A media value lifted out of a success: its kind, and its field, none for the whole success. */
export interface Lifted {
  readonly kind: Kind;
  readonly field: string | undefined;
  readonly value: typeof Media.Type;
}

/**
 * The media `lift` finds in `success`, a decoded value its schema has validated: the whole
 * success's, or each field's, in field order, an array's in its order, none for an absent field.
 */
export const liftedFrom = (lift: Lift, success: ErasedValue): ReadonlyArray<Lifted> =>
  lift.fields.flatMap(({ name, kind, many }) => {
    const value =
      name === undefined
        ? success
        : Predicate.hasProperty(success, name)
          ? success[name]
          : undefined;

    // `liftOf` read the shape from the schema that validated `value`; the guard types it.
    const values = many ? (isMediaArray(value) ? value : []) : isMedia(value) ? [value] : [];

    return values.map((media) => ({ kind, field: name, value: media }));
  });
