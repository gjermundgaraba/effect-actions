# Action

One contract: a name, schemas for input, success and declared errors, and per-transport
metadata. An action holds no behavior; handlers are bound by `ActionGroup.implement`.

## API

```ts
import * as Action from "@gjermundgaraba/effect-actions/Action";

/** Any service-free schema. */
type Codec = Schema.Codec<unknown, unknown, never, never>;

function make<Name, Input = NoInput, Output, Errors = [], Http = true, Mcp = undefined>(
  name: Name,
  options: Options<Input, Output, Errors, Http, Mcp>,
): Action<Name, Input, Output, Errors, Http, Mcp>;

/** What the action does to its resource. Authorization metadata, not an MCP hint. */
type Access = "read" | "write";

interface Options<Input, Output, Errors, Http, Mcp> {
  readonly description: string;
  readonly input?: Input; // omit for an action without arguments
  readonly success: Output;
  readonly errors?: Errors; // ReadonlyArray<Codec>; defaults to []
  readonly access?: Access; // defaults to "write"
  readonly http?: Http; // false hides the action from HTTP routes and clients
  readonly mcp?: Mcp; // false hides the action from MCP; otherwise McpOptions
}

interface McpOptions {
  readonly name?: string; // tool name; defaults to the action name; ^[A-Za-z0-9_-]{1,128}$
  readonly readOnly?: boolean; // readOnlyHint, default access === "read"
  readonly destructive?: boolean; // destructiveHint, default !readOnly
  readonly idempotent?: boolean; // idempotentHint, default false
  readonly openWorld?: boolean; // openWorldHint, default true
}

interface Action<Name, Input, Output, Errors, Http, Mcp> {
  readonly name: Name;
  readonly description: string;
  readonly input: Input;
  readonly success: Output;
  readonly errors: Errors;
  readonly access: Access; // resolved
  readonly http: Http;
  readonly mcp: false | { name; readOnly; destructive; idempotent; openWorld }; // resolved
}

/** Receives decoded input; may fail only with the declared errors. */
type Handler<A extends Any, R = never> = (
  input: A["input"]["Type"],
) => Effect.Effect<A["success"]["Type"], A["errors"][number]["Type"], R>;

type Any; // any action with its schemas erased
```

## Canonical

```ts
import { Schema } from "effect";
import * as Action from "@gjermundgaraba/effect-actions/Action";

export class UserNotFound extends Schema.TaggedError<UserNotFound>()(
  "UserNotFound",
  { id: Schema.String },
  { httpApiStatus: 404 },
) {}

// `access: "read"` states the fact once: it is what the group's `before` hook
// authorizes on, and it is where `mcp.readOnly` comes from.
export const GetUser = Action.make("getUser", {
  description: "Look up a user in your tenant.",
  input: Schema.Struct({ id: Schema.String }),
  success: Schema.Struct({ id: Schema.String, name: Schema.String }),
  errors: [UserNotFound],
  access: "read",
  mcp: { name: "get_user" },
});

// A write. `access` defaults to "write", but say it: the default is a fallback,
// not a statement, and an unclassified action is the one a reviewer must check.
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
- `access` is `"read"` or `"write"` and defaults to `"write"`, so an action nobody classified is treated as the dangerous one. It is authorization metadata for a group's `before` hook (see [ActionGroup.md](ActionGroup.md)); the library itself authorizes nothing and no adapter reads it.
- `access` is independent of `mcp`. A local-only action (`mcp: false`) still has one, and an action may set `access: "write"` with `mcp: { readOnly: true }` if the tool hint should say something else. Derive authorization from `access`, never from a tool hint.
- Both transports are on by default. `http: false` removes the route and the client method. `mcp: false` removes the tool. Both `false` makes a local-only action, reachable through `ActionCli` only.
- MCP input must have an object-root JSON Schema. Scalar or array input is fine for HTTP, but `ActionMcp.layerHttp`, `ActionMcp.layerStdio`, and `ActionToolkit.make` throw when called with such an action. Success and error schemas may be any shape.
- `mcp.name` is the tool name, at most 128 characters, unique within the group and within any Toolkit or MCP projection that serves the group. Default is the action name.
- Hint defaults: `readOnly: access === "read"`, `destructive: !readOnly`, `idempotent: false`, `openWorld: true`. Hints are metadata for the model. They do not enforce authorization, approval, or retries.
- Schemas must be service-free. Put service access in the handler.
- The group name, not the action, is the OpenAPI tag and operation-ID prefix: `<group>.<action>`.
- HTTP strips undeclared input fields. MCP tools are strict (`Tool.Strict`): undeclared arguments are an invalid-arguments result and input schemas publish `additionalProperties: false`. HTTP is not strict, and cannot be made strict without a hack: Effect merges one `HttpApi.ParseOptions` per endpoint and uses it for payload decoding _and_ error encoding, so `onExcessProperty: "error"` also rejects a `TaggedError` instance's own `message` and `stack`, turning a declared 409 into an empty 500. Making the payload schema itself strict would require wrapping it in an open schema, which erases its OpenAPI shape. Declare the fields you accept and treat extra HTTP fields as ignored.

## Failure modes

- Throws at `make`: invalid name, name `then`, `mcp.name` longer than 128 characters or not matching the pattern.
- Type error `Effect<..., X, ...> is not assignable` in `implement`: the handler fails with an undeclared error `X`. Add it to `errors` or handle it.
- `<action>: MCP input must have an object root` thrown by `ActionMcp.layerHttp`, `ActionMcp.layerStdio`, or `ActionToolkit.make`: an MCP-enabled action has non-object input. Wrap it in `Schema.Struct` or set `mcp: false`.
- Handler receives a string where a number was expected: the schema is `Schema.String`, not a transforming codec such as `Schema.FiniteFromString`.
- A read action is refused by an authorization hook that reads `access`: `access` was omitted, so it defaulted to `"write"`. Declare it.
- A tool shows `readOnlyHint: false` for a read: the action sets `mcp: { readOnly: false }` explicitly, which wins over `access`.
