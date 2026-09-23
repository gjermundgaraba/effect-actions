import { JsonSchema, Schema } from "effect";
import type * as Action from "./Action.js";
import type * as ActionGroup from "./ActionGroup.js";
import { assertDistinct, policyErrors } from "./internal/actions.js";

/** One contract, with independently rooted descriptions of its encoded values. */
export interface Entry {
  readonly id: string;
  readonly group: string;
  readonly name: string;
  readonly description: string;
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
  readonly version: "4";
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
 * Describe the supplied groups without acquiring implementations. Schemas describe
 * encoded action values, not MCP's `{ value }` envelope or deployment-specific URLs.
 * The host chooses what, if anything, to publish.
 */
export const make = (...groups: ReadonlyArray<ActionGroup.Any>): Catalog => {
  assertDistinct(
    "catalog group",
    groups.map((group) => group.name),
  );

  return {
    version: "4",
    actions: groups.flatMap((group) =>
      group.actions.map((action): Entry => ({
        id: `${group.name}.${action.name}`,
        group: group.name,
        name: action.name,
        description: action.description,
        mcp: action.mcp,
        input: describe(action.input),
        success: describe(action.success),
        errors: action.errors.map(describe),
        httpSchemaErrors:
          group.schemaError === undefined ? [] : policyErrors(group.schemaError).map(describe),
      })),
    ),
  };
};
