# ActionCatalog

An offline JSON document of contract identities, metadata and encoded-value JSON Schemas.
Built from contracts alone: no implementation, service or server is involved.

## API

Import `@gjermundgaraba/effect-actions/ActionCatalog`.

`make(actions)` takes a list of actions and returns `Catalog`: `version: "5"` and an
ordered `actions` array of `Entry`.

| Entry field                     | Meaning                                                                   |
| ------------------------------- | ------------------------------------------------------------------------- |
| `name`, `description`, `access` | Contract metadata.                                                        |
| `mcp`                           | `false` when hidden from MCP, otherwise the resolved tool name and hints. |
| `input`, `success`              | Standalone draft 2020-12 JSON Schema objects, not wrappers.               |
| `errors`                        | JSON Schema objects for the action's declared errors.                     |

Exported types are `Catalog` and `Entry`.

## Canonical

```ts
import { NodeRuntime } from "@effect/platform-node";
import { Console } from "effect";
import * as ActionCatalog from "@gjermundgaraba/effect-actions/ActionCatalog";
import { Double, GetUser, ListChanges, RenameUser, Status, WhoAmI } from "./contracts.js";

// Contract inspection requires no implementation or domain-service Layer.
Console.log(
  JSON.stringify(
    ActionCatalog.make([Status, GetUser, RenameUser, Double, WhoAmI, ListChanges]),
    null,
    2,
  ),
).pipe(NodeRuntime.runMain);
```

## Rules

- Takes contracts, not implementations. Nothing is acquired or started. Pass `Http.actions` to describe what an HTTP binding serves, or any other selection.
- Entries preserve list order. Names are unique within the catalog and equal the HTTP operation IDs the same actions get from `ActionHttp.make`.
- Schemas describe encoded action values through native `Schema.toJsonSchemaDocument`, which lowers to the JSON codec first. A `Date` is a string, an `Option` a tagged union, a `bigint` a string of digits. These are action values, not MCP's `{ value }` envelope or deployment URLs.
- JSON Schema does not preserve arbitrary Effect transformations or filters. Checks on the decoded side of a transformation, such as `FiniteFromString.check(isGreaterThan(0))`, are not described. The server's decode remains authoritative.
- Each schema root includes its own `$schema` and, where needed, `$defs`. Equal identifiers across entries or fields cannot replace each other; recursive references resolve locally.
- The catalog contains JSON Schema only. Use Effect's `SchemaRepresentation` directly when native schema persistence or revival is needed.
- `errors` lists the action's own declared errors. Binding-level surface errors and schema-error policy errors belong to an HTTP binding and are not listed; read them from `Http.errors` or the OpenAPI document.
- Actions hidden from MCP are included, with `mcp: false`. MCP tool names are not checked for uniqueness: a catalog is not a tool registry. Presence grants no authorization or proof that an endpoint is mounted; the host decides what to publish.
- No search, catalog HTTP endpoint, or TypeScript code generation is provided.

## Failure modes

- `Duplicate action: <name>`: two actions share a name, including one action passed twice. Catalog each HTTP binding separately if they reuse a name.
- Type error passing implementations: pass the contracts, such as `apps.map((app) => app.action)` or the actions themselves.
- Native JSON Schema conversion throws: the codec or its annotations cannot be converted.
- JSON Schema accepts a value the server rejects: custom validation or a decoded-side check is not expressible in the wire schema. Server validation remains authoritative.
