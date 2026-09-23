# ActionCatalog

An offline JSON document of contract identities, metadata and encoded-value JSON Schemas.
Built from contracts alone: no implementation, service or server is involved.

## API

Import `@gjermundgaraba/effect-actions/ActionCatalog`.

`make(...groups)` returns `Catalog`: `version: "4"` and an ordered `actions` array of `Entry`.

| Entry field                          | Meaning                                                             |
| ------------------------------------ | ------------------------------------------------------------------- |
| `id`, `group`, `name`, `description` | Stable `<group>.<action>` identity and contract metadata.           |
| `mcp`                                | Resolved MCP enablement, name and hints.                            |
| `input`, `success`                   | Standalone draft 2020-12 JSON Schema objects, not wrappers.         |
| `errors`                             | JSON Schema objects for own and inherited group errors.             |
| `httpSchemaErrors`                   | JSON Schema objects for HTTP policy errors; empty without a policy. |

Exported types are `Catalog` and `Entry`.

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
- Group names must be unique. Entries preserve group declaration order, then action declaration order.
- `id` is the stable `<group>.<action>` identity, equal to the HTTP operation ID.
- Schemas describe encoded action values through native `Schema.toJsonSchemaDocument`, which lowers to the JSON codec first. A `Date` is a string, an `Option` a tagged union, a `bigint` a string of digits. These are action values, not MCP's `{ value }` envelope or deployment URLs.
- JSON Schema does not preserve arbitrary Effect transformations or filters. Checks on the decoded side of a transformation, such as `FiniteFromString.check(isGreaterThan(0))`, are not described. The server's decode remains authoritative.
- Each schema root includes its own `$schema` and, where needed, `$defs`. Equal identifiers across entries or fields cannot replace each other; recursive references resolve locally.
- The catalog contains JSON Schema only. Use Effect's `SchemaRepresentation` directly when native schema persistence or revival is needed.
- `errors` includes group-level errors. HTTP schema-policy errors are separate in `httpSchemaErrors`. Surface errors belong to bindings and are not listed.
- `access` is omitted; read it from the contract when needed. Actions hidden from MCP are included. Presence grants no authorization or proof that an endpoint is mounted; the host decides what to publish.
- No search, catalog HTTP endpoint, or TypeScript code generation is provided.

## Failure modes

- `Duplicate catalog group: <name>`: two supplied groups share a name, including a group passed twice.
- Type error passing an implementation: pass `app.group` or the group value itself.
- Native JSON Schema conversion throws: the codec or its annotations cannot be converted.
- JSON Schema accepts a value the server rejects: custom validation or a decoded-side check is not expressible in the wire schema. Server validation remains authoritative.
