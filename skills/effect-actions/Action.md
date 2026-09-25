# Action

One contract: a name, schemas for input, success and declared errors, and per-transport
metadata. A contract holds no behavior; `implement` binds a handler to it. Every adapter that
runs handlers takes a list of implementations.

## API

Import `@gjermundgaraba/effect-actions/Action`.

| Export                                               | Purpose                                                                                |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `make(name, options)`                                | Define a pure contract; literal names, access and MCP exclusion stay typed.            |
| `implement(action, handler)`                         | Bind one handler; returns a list of one `Implementation`.                              |
| `implement([actions], handlers)`                     | Bind a record of handlers keyed by action name; returns one implementation per action. |
| `implement(target, builder)`                         | Either form, with an Effect that builds the handler or record once per adapter layer.  |
| `Action`, `Any`, `Options`, `Implementation`         | Concrete and erased contracts, construction options, and bound implementations.        |
| `Codec`, `Fields`, `Handler`, `Access`, `McpOptions` | Service-free codecs, struct fields, typed handlers, read/write, tool metadata.         |

| Option                             | Meaning                                                                     |
| ---------------------------------- | --------------------------------------------------------------------------- |
| `description`, `success`, `access` | Required description, success schema (or fields) and `"read"` / `"write"`.  |
| `input`                            | Optional schema or fields; omission means an empty object.                  |
| `errors`                           | Declared error codecs; defaults to none.                                    |
| `mcp`                              | Defaults to enabled; `false` removes tools, otherwise accepts `McpOptions`. |

`input` and `success` take a schema or plain fields: `{ id: Schema.String }` is
`Schema.Struct({ id: Schema.String })`. MCP options: `name` defaults to the action name;
`readOnly` to `access === "read"`; `destructive` to `!readOnly`; `idempotent` to `false`;
`openWorld` to `true`. Handlers receive decoded input and return decoded success, failing only
with declared errors.

## Canonical

```ts
import { Effect, Schema } from "effect";
import * as Action from "@gjermundgaraba/effect-actions/Action";
import { CurrentActor } from "./auth.js";
import { Users } from "./users.js";

export class UserNotFound extends Schema.TaggedError<UserNotFound>()(
  "UserNotFound",
  { id: Schema.String },
  { httpApiStatus: 404 },
) {}

const User = Schema.Struct({ id: Schema.String, name: Schema.String });

// Contracts: pure values, safe to import in a browser. `access: "read"` states the
// fact once: it is what a surface's `before` hook authorizes on, and where
// `mcp.readOnly` comes from.
export const GetUser = Action.make("getUser", {
  description: "Look up a user in your tenant.",
  input: { id: Schema.String },
  success: User,
  errors: [UserNotFound],
  access: "read",
  mcp: { name: "get_user" },
});

// A write. Every action says which it is; there is no default to fall back on.
export const RenameUser = Action.make("renameUser", {
  description: "Rename a user in your tenant.",
  input: { id: Schema.String, name: Schema.String },
  success: User,
  errors: [UserNotFound],
  access: "write",
  mcp: { name: "rename_user", destructive: false },
});

// No arguments: omit `input`. Identity comes from request context, never from input.
export const WhoAmI = Action.make("whoAmI", {
  description: "Inspect the authenticated actor.",
  success: { id: Schema.String, tenantId: Schema.String },
  access: "read",
});

// Input decoding is the schema's: "21" on the wire, 21 in the handler.
export const Double = Action.make("double", {
  description: "Double a finite number supplied as a string.",
  input: { value: Schema.FiniteFromString },
  success: Schema.Finite,
  access: "read",
});

// One action, one handler, no services.
export const double = Action.implement(Double, ({ value }) => Effect.succeed(value * 2));

// Several actions sharing one builder. Build-time services (Users) are yielded in the
// builder, once per adapter layer. Request-time services (CurrentActor) are yielded
// inside handlers. Authorization is not here: each surface binds one `before` hook.
export const userActions = Action.implement(
  [GetUser, RenameUser, WhoAmI],
  Effect.gen(function* () {
    const users = yield* Users;

    return {
      getUser: ({ id }) => Effect.flatMap(CurrentActor, (actor) => users.get(actor.tenantId, id)),
      renameUser: ({ id, name }) =>
        Effect.flatMap(CurrentActor, (actor) => users.rename(actor, id, name)),
      whoAmI: () => Effect.map(CurrentActor, ({ id, tenantId }) => ({ id, tenantId })),
    };
  }),
);

// Every adapter takes lists of implementations: double, userActions, [...userActions, ...double].
```

## Rules

### Contracts

- Names match `[A-Za-z0-9_-]+`. `then` is rejected: it would make a client thenable.
- Omit `input` for a no-argument action. The default is an empty object schema, which satisfies MCP's object-root requirement. Its client method may be called without an argument.
- `input` and `success` take a schema or fields. Fields become `Schema.Struct(fields)`; each field must be service-free, like every schema here.
- `errors` is a list of schemas, default none. Each keeps its own `httpApiStatus` annotation; an unannotated error is served as HTTP 500. To share errors across actions, spread one constant array into each action's `errors`.
- `access` is `"read"` or `"write"` and is required. `make` also checks it at runtime, so a caller the compiler never sees cannot define an action no rule classifies. It stays a literal on the action, so a rule may switch on it at the type level. It is authorization metadata for a surface's `before` hook (see [guarantees.md](guarantees.md)); the library itself authorizes nothing. Its only built-in uses are default MCP hints, span/log annotations and the catalog.
- `access` is independent of `mcp`. An action hidden from MCP (`mcp: false`) still has one, and an action may set `access: "write"` with `mcp: { readOnly: true }` if the tool hint should say something else. Derive authorization from `access`, never from a tool hint.
- HTTP serves the actions passed to `ActionHttp.make`; to keep an action off HTTP, leave it out of that list. `ActionCli` runs any action locally.
- `mcp: false` removes the tool. The action's type is hidden from MCP only when the options' type has a required `mcp: false`, such as a literal `mcp: false` in the object passed to `make`. Options that may serve it type it as served, so MCP layers keep its handler's requirements: a conditional spread of `{ mcp: false }`, `false | undefined`, a flag-driven value such as `enabled ? {} : false`, or an `Options` value whose `mcp` is optional.
- `make` accepts only the keys `Options` declares. An unknown key is a compile error.
- MCP input must have an object-root JSON Schema, an identified or recursive root included. Scalar or array input is fine for HTTP and for a native Toolkit, but the native MCP server refuses it when an `ActionMcp` layer is built. Success and error schemas may be any shape.
- `mcp.name` is the tool name, matches `[A-Za-z0-9_-]+` except `then`, is at most 128 characters, and must be unique within any Toolkit or MCP projection that serves the action. Default is the action name.
- Hint defaults: `readOnly: access === "read"`, `destructive: !readOnly`, `idempotent: false`, `openWorld: true`. Hints are metadata for the model. They do not enforce authorization, approval, or retries.
- Schemas must be service-free. Put service access in the handler.

### Implementations

- `implement` always returns a list of implementations, one per action: `implement(action, handler)` a list of one, `implement([a, b], { a: ..., b: ... })` one per listed action. Either may take an Effect that builds the handler or the record instead. Every adapter takes such a list; lists combine by spreading: `[...userActions, ...double]`.
- A record has exactly one own-property function per action, keyed by its name. Missing and extra keys are compile errors, for a plain record and for a builder's. An inherited method does not count. Handlers are called without a receiver. Duplicate action names in one call throw at `implement`.
- Records are checked when an adapter layer builds them, never at `implement`. A record that slips past the types (plain JavaScript, a cast) makes the build die: `Unknown handlers` for a key no action names, `Missing handler` for a served action without a function. Nothing is served with a handler missing.
- A builder is shared by every implementation one `implement` call returns. When adapters run it, and why shared resources belong in a Layer rather than the builder: [guarantees.md](guarantees.md#dependency-lifetimes).
- Services yielded in the builder are build-time requirements. Services yielded in a handler are request-time requirements of that handler alone. Adapters keep these separate in their types, per implementation. Use distinct tags for each kind; never provide a request-identity tag at startup (see [guarantees.md](guarantees.md)).
- `Implementation` is nominal. Spreading its properties does not produce an implementation. Adapters match an implementation to a binding's contract by object identity, so implement the exact contract value the binding received.
- Test a handler directly by calling the function you passed to `implement`, or through `ActionToolkit` in process. Keep at least one adapter-level test per transport: direct calls bypass decoding, encoding, middleware and the hook.

## Failure modes

- Throws at `make`: invalid name, name `then`, an `access` that is neither `"read"` nor `"write"`, `mcp.name` longer than 128 characters or not matching the pattern.
- Type error `Effect<..., X, ...> is not assignable` at `implement`: the handler fails with an undeclared error `X`. Add it to the action's `errors` or handle it.
- `Property 'x' is missing in type` at `implement`: the record lacks a handler for action `x`.
- The layer build dies with `Missing handler: <name>`: the record has no own-property function for that action. Add it to the record itself, not to a prototype.
- The layer build dies with `Unknown handlers: <keys>`, or a type error names a key: the record has a handler for an action not in this `implement` call. Remove it, or add its action to the list.
- `Duplicate action: <name>` at `implement`: the list names one action twice.
- Handler receives a string where a number was expected: the schema is `Schema.String`, not a transforming codec such as `Schema.FiniteFromString`.
- `Property 'access' is missing` at `make`: every action declares `"read"` or `"write"`. There is no default.
- A service is resolved once and shared across requests when it should be per request: it was yielded in the builder. Move the `yield*` into the handler.
- A tool shows `readOnlyHint: false` for a read: the action sets `mcp: { readOnly: false }` explicitly, which wins over `access`.
