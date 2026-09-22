# Action

One contract: a name, schemas for input, success and declared errors, and per-transport
metadata. An action holds no behavior; handlers are bound by `ActionGroup.implement`.

## API

Import `@gjermundgaraba/effect-actions/Action`.

| Export                                     | Purpose                                                                            |
| ------------------------------------------ | ---------------------------------------------------------------------------------- |
| `make(name, options)`                      | Define a pure contract; literal names, access and transport exclusions stay typed. |
| `Action`, `Any`, `Options`                 | Concrete contracts, erased contracts and construction options.                     |
| `Codec`, `Handler`, `Access`, `McpOptions` | Service-free codecs, typed handlers, read/write classification and tool metadata.  |

| Option                             | Meaning                                                                      |
| ---------------------------------- | ---------------------------------------------------------------------------- |
| `description`, `success`, `access` | Required description, success codec and `"read"` / `"write"` classification. |
| `input`                            | Optional codec; omission means an empty object.                              |
| `errors`                           | Declared error codecs; defaults to none.                                     |
| `http`                             | Defaults to enabled; `false` removes routes and client methods.              |
| `mcp`                              | Defaults to enabled; `false` removes tools, otherwise accepts `McpOptions`.  |

MCP options: `name` defaults to the action name; `readOnly` to `access === "read"`;
`destructive` to `!readOnly`; `idempotent` to `false`; `openWorld` to `true`.
Handlers receive decoded input and return decoded success, failing only with declared errors.

## Canonical

```ts
import { Schema } from "effect";
import * as Action from "@gjermundgaraba/effect-actions/Action";

export class UserNotFound extends Schema.TaggedError<UserNotFound>()(
  "UserNotFound",
  { id: Schema.String },
  { httpApiStatus: 404 },
) {}

// `access: "read"` states the fact once: it is what a surface's `before` hook
// authorizes on, and it is where `mcp.readOnly` comes from.
export const GetUser = Action.make("getUser", {
  description: "Look up a user in your tenant.",
  input: Schema.Struct({ id: Schema.String }),
  success: Schema.Struct({ id: Schema.String, name: Schema.String }),
  errors: [UserNotFound],
  access: "read",
  mcp: { name: "get_user" },
});

// A write. Every action says which it is; there is no default to fall back on.
export const RenameUser = Action.make("renameUser", {
  description: "Rename a user in your tenant.",
  input: Schema.Struct({ id: Schema.String, name: Schema.String }),
  success: Schema.Struct({ id: Schema.String, name: Schema.String }),
  errors: [UserNotFound],
  access: "write",
  mcp: { name: "rename_user", destructive: false },
});

// No arguments: omit `input`. Identity comes from request context, never from input.
export const WhoAmI = Action.make("whoAmI", {
  description: "Inspect the authenticated actor.",
  success: Schema.Struct({ id: Schema.String, tenantId: Schema.String }),
  access: "read",
});

// MCP-only: no HTTP route, no client method.
export const ListChanges = Action.make("listChanges", {
  description: "List renames in your tenant, oldest first.",
  success: Schema.Struct({ changes: Schema.Array(Schema.String) }),
  access: "read",
  http: false,
  mcp: { name: "list_changes" },
});

// Input decoding is the schema's: "21" on the wire, 21 in the handler.
export const Double = Action.make("double", {
  description: "Double a finite number supplied as a string.",
  input: Schema.Struct({ value: Schema.FiniteFromString }),
  success: Schema.Finite,
  access: "read",
});
```

## Rules

- Names match `[A-Za-z0-9_-]+`. `then` is rejected: it would make a client thenable.
- Omit `input` for a no-argument action. The default is an empty object schema, which satisfies MCP's object-root requirement. Clients still pass `{ payload: {} }`.
- `errors` is a list of schemas, default none. Each keeps its own `httpApiStatus` annotation; an unannotated error is served as HTTP 500. Group-level `errors` are appended to every action of the group (see [ActionGroup.md](ActionGroup.md)).
- A handler may fail only with the declared errors. Anything else is a defect.
- `access` is `"read"` or `"write"` and is required. `make` also checks it at runtime, so a caller the compiler never sees cannot define an action no rule classifies. It stays a literal on the action, so a rule may switch on it at the type level. It is authorization metadata for a surface's `before` hook (see [guarantees.md](guarantees.md)); the library itself authorizes nothing. Its only built-in uses are default MCP hints and span/log annotations; adapters never enforce an authorization rule from it.
- `access` is independent of `mcp`. A local-only action (`mcp: false`) still has one, and an action may set `access: "write"` with `mcp: { readOnly: true }` if the tool hint should say something else. Derive authorization from `access`, never from a tool hint.
- Both transports are on by default. `http: false` removes the route and the client method. `mcp: false` removes the tool. Both `false` makes a local-only action, reachable through `ActionCli` only.
- MCP input must have an object-root JSON Schema, an identified or recursive root included. Scalar or array input is fine for HTTP and for a native Toolkit, but `ActionMcp.layerHttp` and `ActionMcp.layerStdio` throw when called with such an action. Success and error schemas may be any shape.
- `mcp.name` is the tool name, matches `[A-Za-z0-9_-]+` except `then`, is at most 128 characters, unique within the group and within any Toolkit or MCP projection that serves the group. Default is the action name.
- Hint defaults: `readOnly: access === "read"`, `destructive: !readOnly`, `idempotent: false`, `openWorld: true`. Hints are metadata for the model. They do not enforce authorization, approval, or retries.
- Schemas must be service-free. Put service access in the handler.
- The group name, not the action, is the OpenAPI tag and operation-ID prefix: `<group>.<action>`.
- HTTP strips undeclared input fields. MCP tools are strict (`Tool.Strict`): undeclared arguments are an invalid-arguments result and input schemas publish `additionalProperties: false`. HTTP is not strict, and cannot be made strict without a hack: Effect merges one `HttpApi.ParseOptions` per endpoint and uses it for payload decoding _and_ error encoding, so `onExcessProperty: "error"` also rejects a `TaggedError` instance's own `message` and `stack`, turning a declared 409 into an empty 500. Making the payload schema itself strict would require wrapping it in an open schema, which erases its OpenAPI shape. Declare the fields you accept and treat extra HTTP fields as ignored.

## Failure modes

- Throws at `make`: invalid name, name `then`, an `access` that is neither `"read"` nor `"write"`, `mcp.name` longer than 128 characters or not matching the pattern.
- Type error `Effect<..., X, ...> is not assignable` in `implement`: the handler fails with an undeclared error `X`. Add it to `errors` or handle it.
- `<action>: MCP input must have an object root` thrown by `ActionMcp.layerHttp` or `ActionMcp.layerStdio`: an MCP-enabled action has non-object input. Wrap it in `Schema.Struct` or set `mcp: false`.
- Handler receives a string where a number was expected: the schema is `Schema.String`, not a transforming codec such as `Schema.FiniteFromString`.
- `Property 'access' is missing` at `make`: every action declares `"read"` or `"write"`. There is no default.
- A tool shows `readOnlyHint: false` for a read: the action sets `mcp: { readOnly: false }` explicitly, which wins over `access`.
