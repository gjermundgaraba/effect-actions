# Action

One contract: a name, schemas for input, success and declared errors, `access`, and tool
hints. A contract holds no behavior; `implement` binds handlers to contracts. Every surface
that runs handlers takes an implementation or a list of them. The module also exports the
built-in errors every surface answers with.

## API

Import `@gjermundgaraba/effect-actions/Action`.

| Export                                         | Purpose                                                                              |
| ---------------------------------------------- | ------------------------------------------------------------------------------------ |
| `make(name, options)`                          | Define a pure contract; literal names and access stay typed.                         |
| `implement(action, handler)`                   | Bind one handler; returns one `Implementation`.                                      |
| `implement([actions], handlers)`               | Bind a record of handlers keyed by action name; returns one `Implementation` of all. |
| `implement(target, builder)`                   | Either form, with an Effect that builds the handler or record once per host.         |
| `InvalidInput`, `Unauthenticated`, `Forbidden` | Built-in errors: 400, 401, 403, body `{ _tag, message }`; `message` defaults.        |
| `Refusal`                                      | `Unauthenticated \| Forbidden`: what a `before` hook may fail with.                  |
| `Action`, `Any`, `Implementation`              | Concrete and erased contracts, and bound implementations.                            |
| `Codec`, `Handler`, `Access`, `Hints`          | Service-free codecs, typed handlers, read/write, tool hints.                         |

| Option                             | Meaning                                                                    |
| ---------------------------------- | -------------------------------------------------------------------------- |
| `description`, `success`, `access` | Required description, success schema (or fields) and `"read"` / `"write"`. |
| `input`                            | Optional schema or fields; omission means an empty object.                 |
| `errors`                           | Declared error codecs; defaults to none.                                   |
| `hints`                            | Tool hints (`Hints`) for MCP and the Toolkit; each defaults from `access`. |

`input` and `success` take a schema or plain fields: `{ id: Schema.String }` is
`Schema.Struct({ id: Schema.String })`. Hints: `readOnly` defaults to
`access === "read"`; `destructive` to `!readOnly`; `idempotent` to `false`; `openWorld` to
`true`. The tool is named after the action. Handlers receive decoded input and return decoded success, failing only
with declared errors.

## Canonical

Contracts are pure values, safe to import in a browser.

```ts
import { Schema } from "effect";
import * as Action from "@gjermundgaraba/effect-actions/Action";

export const User = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
});

export class UserNotFound extends Schema.TaggedError<UserNotFound>()(
  "UserNotFound",
  { id: Schema.String },
  { httpApiStatus: 404 },
) {}

// Reachable without credentials: it must work before anyone has signed in.
export const Status = Action.make("status", {
  description: "Report whether the service is up.",
  success: { service: Schema.String, users: Schema.Finite },
  access: "read",
});

export const GetUser = Action.make("getUser", {
  description: "Look up a user in your tenant.",
  input: { id: Schema.String },
  success: User,
  errors: [UserNotFound],
  access: "read",
});

export const RenameUser = Action.make("renameUser", {
  description: "Rename a user in your tenant.",
  input: {
    id: Schema.String,
    name: Schema.String.check(Schema.isMinLength(1)),
  },
  success: User,
  errors: [UserNotFound],
  access: "write",
  hints: { destructive: false },
});

// On either transport, input is { value: "21" }. The handler receives numeric 21.
export const Double = Action.make("double", {
  description: "Double a finite number supplied as a string.",
  input: { value: Schema.FiniteFromString },
  success: Schema.Finite,
  access: "read",
});

// Identity comes from the host's authenticated request context, not action input.
export const WhoAmI = Action.make("whoAmI", {
  description: "Inspect the authenticated actor.",
  success: { id: Schema.String, tenantId: Schema.String },
  access: "read",
});

export const Change = Schema.Struct({
  actorId: Schema.String,
  userId: Schema.String,
  name: Schema.String,
});

export const ListChanges = Action.make("listChanges", {
  description: "List the renames made in your tenant, oldest first.",
  success: { changes: Schema.Array(Change) },
  access: "read",
});
```

### Implementations

Build-time services (`Users`) are yielded in a builder; request-time services
(`CurrentActor`) inside handlers. Every surface takes one implementation or a list:
`double`, `userActions`, `[userActions, double]`.

```ts
import { Effect } from "effect";
import * as Action from "@gjermundgaraba/effect-actions/Action";
import { CurrentActor } from "./authorization.js";
import { Double, GetUser, ListChanges, RenameUser, Status, WhoAmI } from "./contracts.js";
import { Users } from "./users.js";

// No request requirement at all, so this action can be served without authentication.
export const status = Action.implement(
  Status,
  Effect.gen(function* () {
    const users = yield* Users;

    return () => Effect.map(users.count, (count) => ({ service: "effect-actions", users: count }));
  }),
);

// Capture Users at startup; resolve CurrentActor per request. Each surface binds
// the `before` hook, which has already refused an actor without the permission
// the action's access needs.
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

// Pure: no builder and no services, so any surface can serve it on its own.
export const double = Action.implement(Double, ({ value }) => Effect.succeed(value * 2));

export const listChanges = Action.implement(
  ListChanges,
  Effect.gen(function* () {
    const users = yield* Users;

    return () =>
      Effect.gen(function* () {
        const actor = yield* CurrentActor;

        return { changes: yield* users.changes(actor.tenantId) };
      });
  }),
);
```

## Rules

### Contracts

- Names are 1 to 128 characters of `[A-Za-z0-9_-]`. `then` is rejected: it would make a client thenable. The name is also the HTTP route segment, the client method and the MCP tool name.
- Omit `input` for a no-argument action. The default is an empty object schema, which satisfies MCP's object-root requirement. Its client method may be called without an argument.
- `input` and `success` take a schema or fields. Fields become `Schema.Struct(fields)`; each field must be service-free, like every schema here.
- `errors` is a list of schemas, default none. Each keeps its own `httpApiStatus` annotation; an unannotated error is served as HTTP 500. To share errors across actions, spread one constant array into each action's `errors`.
- `access` is `"read"` or `"write"` and is required. `make` also checks it at runtime, so a caller the compiler never sees cannot define an action no rule classifies. It stays a literal on the action, so a rule may switch on it at the type level. A surface's `before` hook reads it (see [guarantees.md](guarantees.md)); the library itself authorizes nothing. Its only built-in uses are default hints and span/log annotations.
- `access` is independent of `hints`. An action may set `access: "write"` with `hints: { readOnly: true }` if the tool hint should say something else. Derive authorization from `access`, never from a tool hint.
- A contract says nothing about where it is served. A surface serves the implementations passed to it: to keep an action off HTTP, leave it out of `ActionHttp.make`; to keep it off MCP, leave its implementation out of the MCP layer (implement it on its own if it shares a builder with served actions, which then runs once per `implement` call; keep what the pieces must share in a Layer, which Effect builds once). `ActionCli` runs any action locally.
- `make` accepts only the keys listed above. An unknown key is a compile error.
- MCP input must have an object-root JSON Schema, an identified or recursive root included. Scalar or array input is fine for HTTP and for a native Toolkit, but the native MCP server refuses it when an `ActionMcp` layer is built. Success and error schemas may be any shape.
- Hint defaults: `readOnly: access === "read"`, `destructive: !readOnly`, `idempotent: false`, `openWorld: true`. Hints are metadata for the model. They do not enforce authorization, approval, or retries.
- `InvalidInput`, `Unauthenticated` and `Forbidden` are built in. Every HTTP endpoint declares all three and every tool the two refusals, so do not list them in `errors`. The surface produces them: `InvalidInput` for input that does not decode, a refusal from a `before` hook or `Authentication.middleware`. A handler fails with one only when its action lists it in `errors`, like any other error.
- Build a refusal with or without a message: `new Action.Forbidden()` sends `"Not allowed."`, `new Action.Forbidden({ message: "Requires users:write." })` sends that.
- Schemas must be service-free. Put service access in the handler.

### Implementations

- `implement` returns one `Implementation` of everything it binds: `implement(action, handler)` one action, `implement([a, b], { a: ..., b: ... })` every listed action. Either may take an Effect that builds the handler or the record instead. Every surface takes one implementation or a list: `[userActions, double]`. A surface serves every action of each implementation it receives.
- A record has exactly one own-property function per action, keyed by its name. Missing and extra keys are compile errors, for a plain record and for a builder's. An inherited method does not count. Handlers are called without a receiver. Duplicate action names in one call throw at `implement`.
- A plain handler or record is checked at `implement`; a builder's record when it is built. A record that slips past the types (plain JavaScript, a cast) throws `Unknown handlers` for a key no action names and `Missing handlers` for an action without a function; from a builder, the layer build dies with the same message. Nothing is served with a handler missing.
- A builder runs once per host, however many surfaces serve its implementation, so its startup services are provided once, above every surface: [guarantees.md](guarantees.md#dependency-lifetimes).
- Services yielded in the builder are build-time requirements. Services yielded in a handler are request-time requirements of that handler alone. Surfaces keep these separate in their types, per action. Use distinct tags for each kind; never provide a request-identity tag at startup (see [guarantees.md](guarantees.md)).
- `Implementation` is nominal. Spreading its properties does not produce an implementation. Surfaces match an implementation to an action by object identity, so implement the exact contract value a binding or a CLI selector receives.
- Test a handler directly by calling the function you passed to `implement`, or through `ActionToolkit` in process. Keep at least one test per surface: direct calls bypass decoding, encoding, middleware and the hook.

## Failure modes

- Throws at `make`: invalid name (empty, longer than 128 characters, or another character), name `then`, an `access` that is neither `"read"` nor `"write"`.
- Type error `Effect<..., X, ...> is not assignable` at `implement`: the handler fails with an undeclared error `X`. Add it to the action's `errors` or handle it.
- `Property 'x' is missing in type` at `implement`: the record lacks a handler for action `x`.
- `Missing handlers: <names>` at `implement`, or when a builder's layer builds: the record has no own-property function for those actions. Add them to the record itself, not to a prototype.
- `Unknown handlers: <keys>` at `implement` or when a builder's layer builds, or a type error names a key: the record has a handler for an action not in this `implement` call. Remove it, or add its action to the list.
- `Duplicate action: <name>` at `implement`: the list names one action twice.
- Handler receives a string where a number was expected: the schema is `Schema.String`, not a transforming codec such as `Schema.FiniteFromString`.
- `Property 'access' is missing` at `make`: every action declares `"read"` or `"write"`. There is no default.
- A service is resolved once and shared across requests when it should be per request: it was yielded in the builder. Move the `yield*` into the handler.
- A tool shows `readOnlyHint: false` for a read: the action sets `hints: { readOnly: false }` explicitly, which wins over `access`.
- `Object literal may only specify known properties` at `make`: an option `make` does not take, or a misspelled one.
- A typed client decodes the wrong error for a 400, 401 or 403: the application declares its own error with the `_tag` `InvalidInput`, `Unauthenticated` or `Forbidden`, which the built-in one shares. Use the built-in error, or another tag.
