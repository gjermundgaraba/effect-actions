# ActionCatalog

An offline JSON document describing groups: identities, metadata, and each encoded value
as a standalone JSON Schema and, where Effect can persist it, Effect's own schema
representation. Built from contracts alone. No implementation, service, or server is involved.

## API

```ts
import * as ActionCatalog from "@gjermundgaraba/effect-actions/ActionCatalog";

const make: (...groups: ReadonlyArray<ActionGroup.Any>) => Catalog;

interface Catalog {
  readonly version: "2";
  readonly actions: ReadonlyArray<Entry>;
}

interface Entry {
  readonly id: string; // "<group>.<action>"
  readonly group: string;
  readonly name: string;
  readonly description: string;
  readonly http: boolean;
  readonly mcp: false | { name; readOnly; destructive; idempotent; openWorld };
  readonly input: Described;
  readonly success: Described;
  readonly errors: ReadonlyArray<Described>; // own + inherited group errors
  readonly httpSchemaErrors: ReadonlyArray<Described>; // policy errors, HTTP only
}

interface Described {
  readonly jsonSchema: JsonSchema.JsonSchema; // draft 2020-12, for any consumer
  readonly representation?: Schema.Json; // SchemaRepresentation.toJson; absent when Effect cannot persist the schema
}
```

## Canonical

```ts
import { NodeRuntime } from "@effect/platform-node";
import { Console } from "effect";
import * as ActionCatalog from "@gjermundgaraba/effect-actions/ActionCatalog";
import { AuditActions, PublicActions, UserActions } from "./contracts.js";

// Contract inspection requires no implementation or domain-service Layer.
Console.log(
  JSON.stringify(ActionCatalog.make(PublicActions, UserActions, AuditActions), null, 2),
).pipe(NodeRuntime.runMain);
```

## Rules

- Takes groups, not implementations. Nothing is acquired or started.
- Group names must be unique across the supplied groups. Entries preserve group declaration order, then action declaration order.
- `id` is the stable `<group>.<action>` identity, equal to the HTTP operation ID.
- Schemas describe encoded action values: the JSON on the wire, not MCP's `{ value }` envelope and not deployment URLs.
- Both descriptions come from one lowering of the JSON wire form, the same `Schema.toCodecJson` every adapter sends. A `Date` is a string, an `Option` a tagged union, a `bigint` a string of digits. A codec's transformations are in neither. JSON-valued annotations set with `annotate` are persisted verbatim in `representation`; `TaggedError` class options such as `httpApiStatus` are not part of the wire form and do not appear.
- `representation` is present when Effect can persist the wire form, and then names every check on that form. A check placed after a transformation, such as `FiniteFromString.check(isGreaterThan(0))`, is enforced on the decoded value and is in neither description: revival cannot reject what only the server's decode rejects, so the server stays authoritative. It revives with `SchemaRepresentation.fromJson` then `fromRepresentation`. To generate source, revive first, then `toRepresentation` of the revived AST and `toCodeDocument`: a persisted document carries no code generators. It keeps what JSON Schema cannot name: filters as `{ id, payload }`, brands, identifiers. Pass the revivers for what your schemas use: filter revivers such as `SchemaRepresentation.isMinLengthReviver` or `isStringBigIntReviver`, and `JsonReviver` for `Schema.Json` and `Schema.Unknown` fields, the one declaration the wire form has. None are installed implicitly.
- A schema Effect cannot persist has no `representation`; its `jsonSchema` is unaffected. The usual cause is a filter without a `representation` annotation, such as a plain `Schema.makeFilter`, anywhere in the schema, including inside an annotated filter group. Annotate custom filters with `{ id, payload }` and supply a matching reviver. A contract that relies on revival should assert `representation` is present in its own tests; `make` never fails for this.
- Each schema owns its `$defs`, and each representation its `references`. Equal schema identifiers in different entries never replace each other. Recursive references stay local to their schema.
- `errors` includes group-level errors. HTTP schema-policy errors are listed separately in `httpSchemaErrors`. Surface errors are not listed: they belong to a binding, not to the contract.
- `access` is not in the document. It is authorization metadata for a surface's hook, and the catalog is descriptive; read it from the contract (`group.actions`) when you need it.
- Local-only actions (`http: false`, `mcp: false`) are included. Presence in a catalog is descriptive. It is not authorization, tool publication, or proof that a route is mounted. The host decides what to publish.
- The package adds no search, no catalog HTTP endpoint, and no TypeScript code generation.

## Failure modes

- `Duplicate catalog group: <name>`: two supplied groups share a name, including the same group passed twice. Pass each named group once.
- Type error passing an implementation: `make` takes groups. Pass `app.group` or the group value itself.
- `fromRepresentation` throws `Missing reviver for <id>`: add that reviver to `revivers`. Wire forms carry filters of their own, such as `isStringBigInt` for a `bigint`, and `effect/schema/Json` needs `JsonReviver`. Custom filters need a reviver you write with `SchemaRepresentation.makeReviverFilter`.
- An entry has no `representation`: Effect refused to persist that schema. Annotate the anonymous filter, or fix the `representation.id` it rejected; `SchemaRepresentation.toJson` on the schema's own document reports which.
- A revived schema accepts a value the server rejects: the check sits after a transformation, on the decoded side. Move it to the wire form if consumers must see it.
- Consumers see `{ value }` in MCP responses but not in the catalog: expected. The catalog describes action values; MCP wraps them.
