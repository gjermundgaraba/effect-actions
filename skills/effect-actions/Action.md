# Action

One contract: a name, schemas for input, success and declared errors, `access`, and tool
hints. A contract holds no behavior; `implement` binds handlers to contracts, with the hook every
surface runs before them: whether a caller may call. Every surface that runs handlers takes an
implementation or a list of them. The module also exports the built-in
errors every surface answers with.

## API

Import `@gjermundgaraba/effect-actions/Action`.

| Export                                         | Purpose                                                                              |
| ---------------------------------------------- | ------------------------------------------------------------------------------------ |
| `make(name, options)`                          | Define a pure contract; literal names and access stay typed.                         |
| `implement(action, handler)`                   | Bind one handler; returns one `Implementation`.                                      |
| `implement([actions], handlers)`               | Bind a record of handlers keyed by action name; returns one `Implementation` of all. |
| `implement(target, builder)`                   | Either form, with an Effect that builds the handler or record once per host build.   |
| `implement(target, handlers, before)`          | Any form, with its hook, run on every surface before each handler.                   |
| `InvalidInput`, `Unauthenticated`, `Forbidden` | Built-in errors: 400, 401, 403, body `{ _tag, message }`; `message` defaults.        |
| `Refusal`                                      | `Unauthenticated \| Forbidden`: what authentication or a `before` hook fails with.   |
| `Action`, `Any`, `Implementation`              | Concrete and erased contracts, and bound implementations.                            |
| `AnyImplementation`                            | Any implementation, erased: what every surface accepts.                              |
| `Handler`, `Before`, `Access`                  | Typed handlers, the hook `(action) => Effect<void, Refusal, R>`, `"read"`/`"write"`. |
| `Options`, `Hints`                             | What `make` takes, and its tool hints.                                               |

| Option                  | Meaning                                                          |
| ----------------------- | ---------------------------------------------------------------- |
| `description`, `access` | Required description and `"read"` / `"write"`.                   |
| `input`                 | Optional schema or fields; omitted or `{}`, an empty object.     |
| `success`               | Optional schema or fields; omission means `Schema.Void`.         |
| `errors`                | Declared error codecs; defaults to none.                         |
| `hints`                 | Tool hints for MCP and the Toolkit; each defaults from `access`. |

`before` receives the selected action and fails with a `Refusal`; every surface runs it
([guarantees.md](guarantees.md#dependency-lifetimes)). Authentication is the host's, not
the implementation's ([Authentication.md](Authentication.md)).

`input` and `success` take a schema or plain fields: `{ id: Schema.String }` is
`Schema.Struct({ id: Schema.String })`. A tool is read-only exactly when `access` is
`"read"`. Hints: `destructive`, a write's only, defaults to `true`; `idempotent` to `false`;
`openWorld` to `true`. The tool is named after the action. Handlers receive decoded input and return decoded success, failing only
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
(`CurrentActor`) inside handlers. `authorize` is the hook every surface runs before each
handler; the authentication provided around the HTTP surfaces supplies `CurrentActor`. Every
surface takes one implementation or a list: `double`, `userActions`, `[userActions, double]`.

```ts
import { Effect } from "effect";
import * as Action from "@gjermundgaraba/effect-actions/Action";
import { authorize, CurrentActor } from "./authorization.js";
import { Double, GetUser, ListChanges, RenameUser, Status, WhoAmI } from "./contracts.js";
import { Users } from "./users.js";

// No hook and no request requirement: public on every surface.
export const status = Action.implement(
  Status,
  Effect.gen(function* () {
    const users = yield* Users;

    return () => Effect.map(users.count, (count) => ({ service: "effect-actions", users: count }));
  }),
);

// Capture Users at startup; resolve CurrentActor per request. Every surface runs the
// `authorize` hook before each handler, so it has already refused an actor without the
// permission the action's access needs.
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
  authorize,
);

// Pure: no builder and no services, only the hook.
export const double = Action.implement(Double, ({ value }) => Effect.succeed(value * 2), authorize);

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
  authorize,
);
```

## Rules

### Contracts

- Names are 1 to 128 characters of `[A-Za-z0-9_-]`. `then` is rejected: it would make a client thenable. The name is also the HTTP route segment, the client method and the MCP tool name.
- Omit `input`, or give `{}`, for a no-argument action. Its input is an empty object that accepts only `{}`: over HTTP, extra fields and a missing body are a 400. It is MCP's object root. Its client method may be called without an argument.
- Omit `success` for an action that returns nothing. The default is `Schema.Void`: the client method and `Testing.mcpCall` return `void`, HTTP answers with no content, and a CLI command prints nothing. As for a function returning `void`, its handler may still return a value; the encoding drops it. Declare `success` to return data.
- `input` and `success` take a schema or fields. Fields become `Schema.Struct(fields)`, and no fields the empty object above; each field must be service-free, like every schema here.
- `errors` is a list of schemas, default none. Each keeps its own `httpApiStatus` annotation; an unannotated error is served as HTTP 500. To share errors across actions, spread one constant array into each action's `errors`.
- `access` is `"read"` or `"write"` and is required. `make` also checks it at runtime, so a caller the compiler never sees cannot define an action no rule classifies. It stays a literal on the action, so a rule may switch on it at the type level. An implementation's `before` hook reads it (see [guarantees.md](guarantees.md)); the library itself authorizes nothing. Its only built-in uses are default hints and span/log annotations.
- `access` is also the tool's read-only hint, which no option overrides, so authorization and what MCP clients are told cannot disagree. Derive authorization from `access`, never from a tool hint.
- A contract says nothing about where it is served. A surface serves the implementations passed to it: to keep an action off HTTP, leave it out of `ActionHttp.make`; to keep it off MCP, leave its implementation out of the MCP layer. An action that shares a builder with served ones then needs an `implement` call of its own, whose builder runs separately; keep what the two must share in a Layer, which Effect builds once.
- `make` accepts only the keys listed above. An unknown key is a compile error.
- An option is given or omitted, never a value that may be `undefined`: omitted, it takes its default at run time, so its type would claim what the default does not do. `success: enabled ? Schema.String : undefined`, or the same through a conditional spread, is a compile error, as it is for `input` and `errors`. Branch around the call instead. Options typed as a whole (`Parameters<typeof Action.make>[1]`) are not checked; their action's schemas are as wide as what may run, so its success is `unknown`.
- MCP input must have an object-root JSON Schema, an identified or recursive root included. Scalar or array input is fine for HTTP and for a native Toolkit, but the native MCP server refuses it when an `ActionMcp` layer is built. Success and error schemas may be any shape.
- Hint defaults: `destructive: access === "write"`, `idempotent: false`, `openWorld: true`; `readOnlyHint` is always `access === "read"`. Only a write may state `destructive`: a read is never destructive, as MCP defines the hint for writes only. Hints are metadata for the model. They do not enforce authorization, approval, or retries.
- `InvalidInput`, `Unauthenticated` and `Forbidden` are built in and declared everywhere ([guarantees.md](guarantees.md#wire-behavior)), so do not list them in `errors`. A handler fails with one only when its action lists it in `errors`, like any other error.
- Build a refusal with or without a message: `new Action.Forbidden()` sends `"Not allowed."`, `new Action.Forbidden({ message: "Requires users:write." })` sends that.
- Schemas must be service-free. Put service access in the handler.

### Implementations

- `implement` returns one `Implementation` of everything it binds: `implement(action, handler)` one action, `implement([a, b], { a: ..., b: ... })` every listed action. Either may take an Effect that builds the handler or the record instead. Every surface takes one implementation or a list: `[userActions, double]`. A surface serves every action of each implementation it receives.
- A record has exactly one own-property function per action, keyed by its name. Missing and extra keys are compile errors, for a plain record and for a builder's. An inherited method does not count. Handlers are called without a receiver. Duplicate action names in one call throw at `implement`.
- A plain handler or record is checked at `implement`; a builder's record when it is built. A record that slips past the types (plain JavaScript, a cast) throws `Unknown handlers` for a key no action names and `Missing handlers` for an action without a function; from a builder, the layer build dies with the same message. Nothing is served with a handler missing.
- Builder lifetime, the hook, authentication, and build-time versus request-time services: [guarantees.md](guarantees.md#dependency-lifetimes). Surfaces keep the two kinds of services separate in their types, per action.
- `before` sees `action` typed as the implementation's own actions. The same handlers under another hook, such as a trusted admin CLI, are a second `implement` call over the same builder.
- `before` may be a value that may be `undefined`, as `enabled ? authorize : undefined`: its services are required either way.
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
- `'readOnly' does not exist in type 'Hints'` at `make`: a tool's read-only hint is its `access`. Set `access` instead.
- Type error on `hints.destructive` of a read action: a read is never destructive. Drop the hint, or make the action a write.
- `Type '...' is not assignable to type 'never'` on a key at `make`: an option it does not take, or a misspelled one.
- Type error naming `Give this option or omit it: a value that may be undefined is neither`: an option of `make` may be `undefined`, directly or through a conditional spread. Branch around the call.
- `Object literal may only specify known properties, and 'before' does not exist` at `implement`: the hook is the third argument itself, not an option of an object.
- A typed client decodes the wrong error for a 400, 401 or 403: the application declares its own error with the `_tag` `InvalidInput`, `Unauthenticated` or `Forbidden`, which the built-in one shares. Use the built-in error, or another tag.
