import { JsonSchema, Schema } from "effect";
import type * as Action from "./Action.js";
import type * as ActionGroup from "./ActionGroup.js";
import { assertDistinct } from "./internal/actions.js";

/** One contract, with independently rooted JSON schemas for its encoded values. */
export interface Entry {
  readonly id: string;
  readonly group: string;
  readonly name: string;
  readonly description: string;
  /** Authorization metadata, resolved: `"write"` unless the contract says `"read"`. */
  readonly access: Action.Access;
  readonly http: boolean;
  readonly mcp: Action.Any["mcp"];
  readonly input: JsonSchema.JsonSchema;
  readonly success: JsonSchema.JsonSchema;
  /** Includes the errors inherited from the group; not HTTP schema-policy errors. */
  readonly errors: ReadonlyArray<JsonSchema.JsonSchema>;
  /** HTTP-only decoding/encoding policy errors, separate from handler failures. */
  readonly httpSchemaErrors: ReadonlyArray<JsonSchema.JsonSchema>;
}

/** An offline contract document, not an authorization decision or a mounted endpoint. */
export interface Catalog {
  readonly version: "1";
  readonly actions: ReadonlyArray<Entry>;
}

const jsonSchema = (codec: Action.Codec): JsonSchema.JsonSchema => {
  const document = Schema.toJsonSchemaDocument(codec);

  // Each schema owns its definitions. Combining definition maps across actions
  // would silently overwrite equal identifiers that describe different types.
  return {
    $schema: JsonSchema.META_SCHEMA_URI_DRAFT_2020_12,
    ...document.schema,
    ...(Object.keys(document.definitions).length === 0 ? {} : { $defs: document.definitions }),
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
    version: "1",
    actions: groups.flatMap((group) =>
      group.actions.map((action): Entry => ({
        id: `${group.name}.${action.name}`,
        group: group.name,
        name: action.name,
        description: action.description,
        access: action.access,
        http: action.http,
        mcp: action.mcp,
        input: jsonSchema(action.input),
        success: jsonSchema(action.success),
        errors: action.errors.map(jsonSchema),
        httpSchemaErrors: action.http ? (group.schemaError?.errors.map(jsonSchema) ?? []) : [],
      })),
    ),
  };
};
