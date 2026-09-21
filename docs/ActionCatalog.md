# ActionCatalog

An offline JSON document describing groups: identities, metadata, and standalone JSON
schemas. Built from contracts alone. No implementation, service, or server is involved.

## API

```ts
import * as ActionCatalog from "@gjermundgaraba/effect-actions/ActionCatalog";

const make: (...groups: ReadonlyArray<ActionGroup.Any>) => Catalog;

interface Catalog {
  readonly version: "1";
  readonly actions: ReadonlyArray<Entry>;
}

interface Entry {
  readonly id: string; // "<group>.<action>"
  readonly group: string;
  readonly name: string;
  readonly description: string;
  readonly http: boolean;
  readonly mcp: false | { name; readOnly; destructive; idempotent; openWorld };
  readonly input: JsonSchema.JsonSchema;
  readonly success: JsonSchema.JsonSchema;
  readonly errors: ReadonlyArray<JsonSchema.JsonSchema>; // own + inherited group errors
  readonly httpSchemaErrors: ReadonlyArray<JsonSchema.JsonSchema>; // policy errors, HTTP only
}
```

## Canonical

```ts
import * as ActionCatalog from "@gjermundgaraba/effect-actions/ActionCatalog";
import { AuditActions, PublicActions, UserActions } from "./contracts.js";

const catalog = ActionCatalog.make(PublicActions, UserActions, AuditActions);

process.stdout.write(JSON.stringify(catalog, null, 2));
```

## Rules

- Takes groups, not implementations. Nothing is acquired or started.
- `id` is the stable `<group>.<action>` identity, equal to the HTTP operation ID.
- Schemas describe encoded action values: the JSON on the wire, not MCP's `{ value }` envelope and not deployment URLs.
- Each schema owns its `$defs`. Equal schema identifiers in different entries never replace each other. Recursive references stay local to their schema.
- `errors` includes group-level errors. HTTP schema-policy errors are listed separately in `httpSchemaErrors`. Surface errors are not listed: they belong to a binding, not to the contract.
- `access` is not in the document. It is authorization metadata for a surface's hook, and the catalog is descriptive; read it from the contract (`group.actions`) when you need it.
- Local-only actions (`http: false`, `mcp: false`) are included. Presence in a catalog is descriptive. It is not authorization, tool publication, or proof that a route is mounted. The host decides what to publish.
- The package adds no search, no catalog HTTP endpoint, and no TypeScript code generation.

## Failure modes

- Type error passing an implementation: `make` takes groups. Pass `app.group` or the group value itself.
- Consumers see `{ value }` in MCP responses but not in the catalog: expected. The catalog describes action values; MCP wraps them.
