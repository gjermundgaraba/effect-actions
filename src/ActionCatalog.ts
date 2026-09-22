import { JsonSchema, Schema, SchemaRepresentation } from "effect";
import type * as Action from "./Action.js";
import type * as ActionGroup from "./ActionGroup.js";
import { assertDistinct } from "./internal/actions.js";

/**
 * One encoded value, described twice. `jsonSchema` serves any consumer.
 * `representation` is Effect's own persisted form, which revives with
 * `SchemaRepresentation.fromJson`; when present it carries every check on the
 * wire form, and it is absent when Effect cannot persist that form, such as
 * one with a filter that has no `representation` annotation. Neither carries
 * the codec's transformations, nor a check placed after one: both describe the
 * wire value, and the server's decode remains the authority.
 */
export interface Described {
  readonly jsonSchema: JsonSchema.JsonSchema;
  readonly representation?: Schema.Json;
}

/** One contract, with independently rooted descriptions of its encoded values. */
export interface Entry {
  readonly id: string;
  readonly group: string;
  readonly name: string;
  readonly description: string;
  readonly http: boolean;
  readonly mcp: Action.Any["mcp"];
  readonly input: Described;
  readonly success: Described;
  /** Includes the errors inherited from the group; not HTTP schema-policy errors. */
  readonly errors: ReadonlyArray<Described>;
  /** HTTP-only decoding/encoding policy errors, separate from handler failures. */
  readonly httpSchemaErrors: ReadonlyArray<Described>;
}

/** An offline contract document, not an authorization decision or a mounted endpoint. */
export interface Catalog {
  readonly version: "2";
  readonly actions: ReadonlyArray<Entry>;
}

/** Effect refuses what it cannot persist; the catalog then describes the value once. */
const persisted = (document: SchemaRepresentation.Document): Schema.Json | undefined => {
  try {
    return SchemaRepresentation.toJson(document);
  } catch {
    return undefined;
  }
};

/**
 * Both descriptions come from one lowering of the JSON codec, the form every
 * adapter puts on the wire, so when both are present they cannot disagree with
 * it or with each other.
 */
const describe = (codec: Action.Codec): Described => {
  const document = SchemaRepresentation.toRepresentation(Schema.toCodecJson(codec).ast);
  const { schema, definitions } = SchemaRepresentation.toJsonSchemaDocument(document);
  const representation = persisted(document);

  return {
    // Each schema owns its definitions. Combining definition maps across actions
    // would silently overwrite equal identifiers that describe different types.
    jsonSchema: {
      $schema: JsonSchema.META_SCHEMA_URI_DRAFT_2020_12,
      ...schema,
      ...(Object.keys(definitions).length === 0 ? {} : { $defs: definitions }),
    },
    ...(representation === undefined ? {} : { representation }),
  };
};

/**
 * Describe the supplied groups without acquiring implementations. Schemas describe
 * encoded action values, not MCP's `{ value }` envelope or deployment-specific URLs.
 * Local-only actions are included; the host chooses what, if anything, to publish.
 */
export const make = (...groups: ReadonlyArray<ActionGroup.Any>): Catalog => {
  assertDistinct(
    "catalog group",
    groups.map((group) => group.name),
  );

  return {
    version: "2",
    actions: groups.flatMap((group) =>
      group.actions.map((action): Entry => ({
        id: `${group.name}.${action.name}`,
        group: group.name,
        name: action.name,
        description: action.description,
        http: action.http,
        mcp: action.mcp,
        input: describe(action.input),
        success: describe(action.success),
        errors: action.errors.map(describe),
        httpSchemaErrors: action.http ? (group.schemaError?.errors.map(describe) ?? []) : [],
      })),
    ),
  };
};
