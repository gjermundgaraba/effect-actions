import { JsonSchema, Schema } from "effect";
import type * as Action from "./Action.js";
import { assertDistinct } from "./internal/actions.js";

/** One contract, with independently rooted descriptions of its encoded values. */
export interface Entry {
  readonly name: string;
  readonly description: string;
  readonly access: Action.Access;
  readonly mcp: Action.Any["mcp"];
  readonly input: JsonSchema.JsonSchema;
  readonly success: JsonSchema.JsonSchema;
  readonly errors: ReadonlyArray<JsonSchema.JsonSchema>;
}

/** An offline contract document, not an authorization decision or a mounted endpoint. */
export interface Catalog {
  readonly version: "5";
  readonly actions: ReadonlyArray<Entry>;
}

/** Describe the JSON wire form; decoding on the server remains authoritative. */
const describe = (codec: Action.Codec): JsonSchema.JsonSchema => {
  const { schema, definitions } = Schema.toJsonSchemaDocument(codec);

  // Each root owns its definitions, so equal identifiers never overwrite another schema.
  return {
    $schema: JsonSchema.META_SCHEMA_URI_DRAFT_2020_12,
    ...schema,
    ...(Object.keys(definitions).length === 0 ? {} : { $defs: definitions }),
  };
};

/**
 * Describe actions without acquiring implementations. Schemas describe encoded action
 * values, not MCP's `{ value }` envelope or deployment-specific URLs. The host chooses
 * what, if anything, to publish.
 */
export const make = (actions: ReadonlyArray<Action.Any>): Catalog => {
  assertDistinct(
    "action",
    actions.map((action) => action.name),
  );

  return {
    version: "5",
    actions: actions.map((action): Entry => ({
      name: action.name,
      description: action.description,
      access: action.access,
      mcp: action.mcp,
      input: describe(action.input),
      success: describe(action.success),
      errors: action.errors.map(describe),
    })),
  };
};
