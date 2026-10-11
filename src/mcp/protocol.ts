import { Predicate, Schema, SchemaAST } from "effect";
import { McpProtocol } from "effect/ai";
import type * as Action from "../contract/Action.js";
import type { ErasedValue } from "../contract/implementation.js";
import { isMarked, type Kind, kindOf, Media } from "../contract/media.js";
import { unsuspended } from "../contract/rules.js";

// Why: Only the stateless revision. A stateful one keeps a session per `initialize`, which
// Effect's HTTP runtime never expires and any holder of its id may use. And a mixed endpoint's gate
// decides from the routing headers, which the runtime checks against the body of a stateless
// request alone.
export const httpProtocol = McpProtocol.v2026_07_28;

export const defaultPath = "/mcp";

/**
 * An MCP request's parameters, as `Testing.mcpRequest` takes them: JSON, with any `_meta`, leaving
 * out an `undefined` one, as a caller may.
 */
export interface Params {
  readonly _meta?: { readonly [key: string]: Schema.Json };
  readonly [key: string]: Schema.Json | undefined;
}

const mcpNameHeaderOf = (method: string, params: Params) =>
  method === "resources/read" ? params.uri : params.name;

/**
 * One stateless MCP request of `method` with `params`, as `ActionMcp.layerHttp` serves it:
 * the headers routing it, which repeat what its body says, and its JSON-RPC body. The client
 * metadata goes in `_meta`, under any given, such as a `progressToken`; the protocol version
 * is always the request's own.
 */
export const statelessRequest = (method: string, params: Params) => {
  const { protocolVersion } = httpProtocol;
  const name = mcpNameHeaderOf(method, params);

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

type Codec = Action.Any["success"];

export const fieldKey = "effect-actions/field";

const isMedia = Schema.is(Media);

const isMediaArray = Schema.is(Schema.Array(Media));

export interface Field {
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
