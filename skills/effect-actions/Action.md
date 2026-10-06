# Action

One contract: a name, schemas for input, success and declared errors, whether it is read-only
(`readOnly`), who may call it (`caller`), the checks that run before its handler, and how its tool
presents itself over MCP (`mcp`). A contract holds no behavior;
`implement` binds handlers to contracts, with the authorization every surface runs before a
protected action's handler: whether this caller may call it. Every surface that runs handlers
takes an implementation or a list of them, and so does `client`, which calls them in process
with the methods `ActionHttp.client` has. The module also declares checks, operational rules
such as a rate limit, and exports the built-in errors every surface declares and any handler may
fail with.

## API

Import `@gjermundgaraba/effect-actions/Action`.

| Export                                          | Purpose                                                                              |
| ----------------------------------------------- | ------------------------------------------------------------------------------------ |
| `make(name, options)`                           | Define a pure contract; literal names, `readOnly` and `caller` stay typed.           |
| `byName(actions)`                               | A list of actions keyed by name, each its exact contract: `contracts.getUser`.       |
| `implement(action, handler, { authorize })`     | Bind one handler, and a protected action's authorizer; returns one `Implementation`. |
| `implement([actions], handlers, { authorize })` | Bind a record of handlers keyed by action name; returns one `Implementation` of all. |
| `implement(target, builder, options?)`          | Either form, with an Effect that builds the handler or record once per layer graph.  |
| `allowAll`                                      | The authorizer without an action-level rule: every authenticated caller may call.    |
| `Anyone`                                        | The caller of a public action, `caller: Action.Anyone`: anyone, signed in or not.    |
| `Check<Self>()(name, { error, requires? })`     | Declare a check, its one error and per-call services; a native layer implements it.  |
| `layer(implementations)`                        | Their builders as one layer: provided above every surface, each runs once for all.   |
| `client(implementations, { actions? })`         | An Effect of a caller running them in process: `client.<action>(input)`.             |
| `InvalidInput`, `Unauthenticated`, `Forbidden`  | Built-in errors: 400, 401, 403, body `{ _tag, message }`; `message` defaults.        |
| `InvalidInput.fromSchemaError(error)`           | The `InvalidInput` every surface answers a `Schema.SchemaError` with.                |
| `Refusal`                                       | `Unauthenticated \| Forbidden`: what authentication or an authorizer refuses with.   |
| `BuiltIn`                                       | `InvalidInput \| Refusal`: what any handler may fail with beyond its `errors`.       |
| `Action`, `Any`, `Implementation`               | Concrete and erased contracts, and bound implementations.                            |
| `Client<Apps>`                                  | What `client` gives for the implementations `Apps`, one or a list.                   |
| `AnyImplementation`, `AnyImplementation<A>`     | Any implementation, or any of actions `A`, erased: a generic helper's constraint.    |
| `AnyCheck`                                      | Any check declaration, erased: what `checks` takes.                                  |
| `CheckCallback`, `CheckContext`, `BuildContext` | A check's callback and what it reads, and what a surface reads at startup.           |
| `implementation.actions`                        | Its exact contract values, as `Testing.mcpClient(users.actions)` takes them.         |
| `Handler`, `Authorize`                          | Typed handlers, and authorizers `(action) => Effect<void, Refusal, R>`.              |
| `Handlers`                                      | A list's handlers keyed by name, for a builder written apart from `implement`.       |
| `Options`, `ClientOptions`, `Mcp`               | What `make` and `client` take, and `make`'s `mcp` options.                           |

| Option        | Meaning                                                                                        |
| ------------- | ---------------------------------------------------------------------------------------------- |
| `description` | Required description.                                                                          |
| `readOnly`    | Required: whether the action leaves its resource unchanged.                                    |
| `caller`      | Required: `Action.Anyone`, or the identity service a caller must have, such as `CurrentActor`. |
| `input`       | Optional schema or fields; omitted or `{}`, an empty object.                                   |
| `success`     | Optional schema or fields; omission means `Schema.Void`.                                       |
| `errors`      | Declared error codecs; defaults to none.                                                       |
| `checks`      | Declared checks, run in order before the handler; each one's error joins the action's errors.  |
| `mcp`         | The tool's MCP hints, in MCP's names, its `title` and `_meta`, and the library's `text`.       |

`authorize` is required where the target holds a protected action, and refused where it holds
none. It receives the selected action and fails only with a `Refusal`; every surface runs it
for protected actions, after authentication and input decoding
([guarantees.md](guarantees.md#authorization)). It may instead be an Effect that builds it, as a
builder builds handlers. Authentication is the surface's: a remote one verifies the identity a
protected contract declares through the descriptor its binding or endpoint names
([Authentication.md](Authentication.md)); on a local one the host provides it.

`input` and `success` take a schema or plain fields: `{ id: Schema.String }` is
`Schema.Struct({ id: Schema.String })`. A tool is read-only exactly when its action is
(`readOnlyHint`). `mcp` takes MCP's own hints, `destructiveHint`, `idempotentHint` and
`openWorldHint`, each MCP's default when left out, but `destructiveHint`, which is `false` for a
read-only action. The tool is named after the action. Handlers receive decoded input and return
decoded success, failing only with declared errors and the built-in ones.

## Canonical

Contracts are pure values, safe to import in a browser. A protected contract names its identity,
a `Context.Service` declared without a verifier.

```ts example=contracts.ts
import { Schema } from "effect";
import * as Action from "@gjermundgaraba/effect-actions/Action";
import { CurrentActor } from "./authorization.js";

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
  readOnly: true,
  caller: Action.Anyone,
});

export const GetUser = Action.make("getUser", {
  description: "Look up a user in your tenant.",
  input: { id: Schema.String },
  success: User,
  errors: [UserNotFound],
  readOnly: true,
  caller: CurrentActor,
});

export const RenameUser = Action.make("renameUser", {
  description: "Rename a user in your tenant.",
  input: {
    id: Schema.String,
    name: Schema.String.check(Schema.isMinLength(1)),
  },
  success: User,
  errors: [UserNotFound],
  readOnly: false,
  caller: CurrentActor,
  mcp: { destructiveHint: false },
});

// On either transport, input is { value: "21" }. The handler receives numeric 21.
export const Double = Action.make("double", {
  description: "Double a finite number supplied as a string.",
  input: { value: Schema.FiniteFromString },
  success: Schema.Finite,
  readOnly: true,
  caller: CurrentActor,
});

// Identity comes from the host's authenticated request context, not action input.
export const WhoAmI = Action.make("whoAmI", {
  description: "Inspect the authenticated actor.",
  success: { id: Schema.String, tenantId: Schema.String },
  readOnly: true,
  caller: CurrentActor,
});

export const Change = Schema.Struct({
  actorId: Schema.String,
  userId: Schema.String,
  name: Schema.String,
});

export const ListChanges = Action.make("listChanges", {
  description: "List the renames made in your tenant, oldest first.",
  success: { changes: Schema.Array(Change) },
  readOnly: true,
  caller: CurrentActor,
});
```

### Identity and authorization

The module the contracts, the implementations, the authentication and every local caller import:
the identity, `CurrentActor`, which the protected contracts declare and authentication provides
per request, and `authorize`, which reads each action's `readOnly`. Its demo actors stand in for
the identities a token verifier returns.

```ts example=authorization.ts
import { Context, Effect } from "effect";
import * as Action from "@gjermundgaraba/effect-actions/Action";

export type Permission = "users:read" | "users:write";

export interface Actor {
  readonly id: string;
  readonly tenantId: string;
  readonly permissions: ReadonlyArray<Permission>;
}

/** DEMO ONLY: fixed credentials, not OAuth or a production token verifier. */
export const actors = {
  alice: { id: "alice", tenantId: "acme", permissions: ["users:read", "users:write"] },
  reader: { id: "reader", tenantId: "acme", permissions: ["users:read"] },
  bob: { id: "bob", tenantId: "other", permissions: ["users:read", "users:write"] },
} as const satisfies Readonly<Record<string, Actor>>;

/**
 * The identity a protected contract declares, `caller: CurrentActor`: provided per request by
 * authentication, and by the host on a local surface.
 */
export class CurrentActor extends Context.Service<CurrentActor, Actor>()("example/CurrentActor") {}

/**
 * One authorization rule for every surface, derived from each contract's own `readOnly`. An
 * implementation of protected actions states it, `{ authorize }`, so every surface serving
 * them runs it before each handler, once the caller is authenticated, and no handler contains
 * authorization code. Its `Forbidden` is built in: every endpoint and tool declares it, and
 * every client decodes it. Naming the missing scope makes it the `insufficient_scope`
 * challenge an OAuth client steps up on.
 */
export const authorize = Effect.fn("authorize")(function* (action: Action.Any) {
  const permission: Permission = action.readOnly ? "users:read" : "users:write";
  const actor = yield* CurrentActor;

  if (!actor.permissions.includes(permission)) {
    return yield* new Action.Forbidden({
      message: `Requires ${permission}.`,
      scopes: [permission],
    });
  }
});
```

### Implementations

Build-time services (`Users`) are yielded in a builder; request-time services
(`CurrentActor`) inside handlers. The implementations of protected actions state `authorize`,
which every surface runs before each of their handlers; the public `status` states none.
Every surface takes one implementation or a list: `double`, `userActions`,
`[status, userActions, double]`. Implementations group actions by domain, not by surface or by
who may call them: `userActions` holds `listChanges`, which HTTP does not serve because its
binding leaves it out, and one implementation may hold public and protected actions alike.

```ts example=handlers.ts
import { Effect } from "effect";
import * as Action from "@gjermundgaraba/effect-actions/Action";
import { authorize, CurrentActor } from "./authorization.js";
import { Double, GetUser, ListChanges, RenameUser, Status, WhoAmI } from "./contracts.js";
import { Users } from "./users.js";

// A public contract: no authorization runs, and it owes nothing per request, on every
// surface.
export const status = Action.implement(
  Status,
  Effect.gen(function* () {
    const users = yield* Users;

    return () => Effect.map(users.count, (count) => ({ service: "effect-actions", users: count }));
  }),
);

// Capture Users at startup; resolve CurrentActor per request. Every surface authenticates
// the caller, then runs `authorize` before each handler, so it has already refused an actor
// without the permission the action needs. HTTP serves only the actions its binding holds:
// `listChanges`, which it leaves out, is a tool and a command, never a route.
export const userActions = Action.implement(
  [GetUser, RenameUser, WhoAmI, ListChanges],
  Effect.gen(function* () {
    const users = yield* Users;

    return {
      getUser: ({ id }) => Effect.flatMap(CurrentActor, (actor) => users.get(actor.tenantId, id)),
      renameUser: ({ id, name }) =>
        Effect.flatMap(CurrentActor, (actor) => users.rename(actor, id, name)),
      whoAmI: () => Effect.map(CurrentActor, ({ id, tenantId }) => ({ id, tenantId })),
      listChanges: () =>
        Effect.gen(function* () {
          const actor = yield* CurrentActor;

          return { changes: yield* users.changes(actor.tenantId) };
        }),
    };
  }),
  { authorize },
);

// Pure: no builder and no services, only the authorization.
export const double = Action.implement(Double, ({ value }) => Effect.succeed(value * 2), {
  authorize,
});
```

### Built authorization

An authorizer that reads a startup service, such as a permission store, is built as handlers
are: an Effect yields the store once and returns the authorizer, which yields the caller on every
call. The host provides `Permissions.layerMemory` at startup, as it provides `Users`;
authentication still provides `CurrentActor` per request. Defined apart from `implement`, its
`action` is annotated; written in `implement`'s options, it would be inferred.

```ts example=authorization-built.ts
import { Context, Effect, Layer } from "effect";
import * as Action from "@gjermundgaraba/effect-actions/Action";
import { actors, CurrentActor, type Permission } from "./authorization.js";
import { WhoAmI } from "./contracts.js";

/** DEMO ONLY: each actor's permissions, kept in a store rather than in the identity. */
export class Permissions extends Context.Service<
  Permissions,
  { readonly of: (actorId: string) => Effect.Effect<ReadonlyArray<Permission>> }
>()("example/Permissions") {
  static readonly layerMemory = Layer.succeed(Permissions, {
    of: (actorId) =>
      Effect.succeed(Object.values(actors).find(({ id }) => id === actorId)?.permissions ?? []),
  });
}

// The `authorize` rule, built as handlers are: the store is yielded once, a startup service
// provided next to `Users`, and the function it returns yields the actor on every call.
export const authorizeStored = Effect.gen(function* () {
  const permissions = yield* Permissions;

  return (action: Action.Any) =>
    Effect.gen(function* () {
      const permission: Permission = action.readOnly ? "users:read" : "users:write";
      const actor = yield* CurrentActor;

      if (!(yield* permissions.of(actor.id)).includes(permission)) {
        return yield* new Action.Forbidden({
          message: `Requires ${permission}.`,
          scopes: [permission],
        });
      }
    });
});

// Built once per layer graph for this implementation, and per invocation of a local command.
export const whoAmI = Action.implement(
  WhoAmI,
  () => Effect.map(CurrentActor, ({ id, tenantId }) => ({ id, tenantId })),
  { authorize: authorizeStored },
);
```

### Checks

An operational rule every surface runs, declared on the contracts it applies to: its
declaration names its error, `RateLimited`, which joins each listing action's errors, and the
service it reads per call. A native layer implements it: `Layer.succeed(Limited, callback)`, or,
as here, `Layer.effect` building the callback once per layer graph from a startup `Limiter`, so
every surface of the graph counts against one.

```ts example=checks.ts
import { Context, Effect, Layer, Schema } from "effect";
import * as Action from "@gjermundgaraba/effect-actions/Action";
import * as ActionHttp from "@gjermundgaraba/effect-actions/ActionHttp";
import { authenticate } from "./authentication.js";
import { authorize, CurrentActor } from "./authorization.js";
import { Login } from "./binding.js";

export class RateLimited extends Schema.TaggedError<RateLimited>()(
  "RateLimited",
  { retryAfter: Schema.Finite },
  { httpApiStatus: 429 },
) {}

// A declaration, transport-free as a contract is: the error the check may fail with, and the
// one service it reads per call.
export class Limited extends Action.Check<Limited>()("example/Limited", {
  error: RateLimited,
  requires: CurrentActor,
}) {}

// `RateLimited` joins the action's errors: every surface declares it, every client decodes it.
export const Invite = Action.make("invite", {
  description: "Invite someone to your tenant.",
  input: { email: Schema.String },
  readOnly: false,
  caller: CurrentActor,
  checks: [Limited],
});

/** DEMO ONLY: ten calls per caller, counted in memory and never reset. */
export class Limiter extends Context.Service<
  Limiter,
  { readonly take: (key: string) => Effect.Effect<void, RateLimited> }
>()("example/Limiter") {
  static readonly layerMemory = Layer.sync(Limiter, () => {
    const counts = new Map<string, number>();

    return Limiter.of({
      take: (key) =>
        Effect.suspend(() => {
          const count = counts.get(key) ?? 0;

          if (count >= 10) return Effect.fail(new RateLimited({ retryAfter: 60 }));

          counts.set(key, count + 1);

          return Effect.void;
        }),
    });
  });
}

// Built once per layer graph, so every surface serving `Invite` counts against one limiter;
// per call it reads only the service `Limited` requires.
export const LimitedLive = Layer.effect(
  Limited,
  Effect.map(
    Limiter,
    (limiter) => () => Effect.flatMap(CurrentActor, ({ id }) => limiter.take(id)),
  ),
).pipe(Layer.provide(Limiter.layerMemory));

// `authorize` refuses, the check limits, and the handler does neither.
export const invite = Action.implement(Invite, ({ email }) => Effect.log(`Invited ${email}.`), {
  authorize,
});

export const InviteHttp = ActionHttp.make([Invite], { authentication: Login });

// Every surface serving `invite` owes `Limited` at startup, as it owes a builder's services.
export const routes = ActionHttp.layer(InviteHttp, invite).pipe(
  Layer.provide([authenticate, LimitedLive]),
);
```

### Client

Implementations called in process, by code: a test, a job, a command of your own. The client is
acquired once, where builders live, and each call is given its caller, as authentication gives
one per request, so one client serves several callers. Every implemented action has a method,
`listChanges` included, which no binding holds; `actions` lists fewer.

```ts example=in-process.ts
import { Effect } from "effect";
import * as Action from "@gjermundgaraba/effect-actions/Action";
import { actors, CurrentActor } from "./authorization.js";
import { userActions } from "./handlers.js";
import { Users } from "./users.js";

// Each call names its caller, as authentication names one per request.
const asAlice = Effect.provideService(CurrentActor, actors.alice);

const asReader = Effect.provideService(CurrentActor, actors.reader);

const program = Effect.gen(function* () {
  // Acquired once, as a layer is built: the builders run here, not per call.
  const users = yield* Action.client(userActions);

  // The methods of `ActionHttp.client(Http)`, with no transport between: each call decodes
  // its input, runs `authorize`, then the handler, and checks the success or the failure.
  const renamed = yield* users.renameUser({ id: "1", name: "Bea" }).pipe(asAlice);
  const refused = yield* Effect.flip(users.renameUser({ id: "1", name: "Cy" }).pipe(asReader));
  const { changes } = yield* users.listChanges().pipe(asReader); // not an HTTP route

  return { renamed, refused, changes };
});

// The builders are released with the program's scope, before the services they captured.
console.log(
  await Effect.runPromise(program.pipe(Effect.scoped, Effect.provide(Users.layerMemory))),
);
```

## Rules

### Contracts

- Names are 1 to 128 characters of `[A-Za-z0-9_-]`. `then` is rejected: it would make a client thenable. The name is also the HTTP route segment, the client method and the MCP tool name.
- Omit `input`, or give `{}`, for a no-argument action. Its input is an empty object that accepts only `{}`: over HTTP, extra fields and an empty JSON body are a 400. It is MCP's object root. Its client method may be called without an argument.
- Omit `success` for an action that returns nothing. The default is `Schema.Void`: the client methods of `ActionHttp.client` and `Testing.mcpClient` return `void`, HTTP answers with no content, and a CLI command prints nothing by default or with `--json`; a custom `render` may print text. As for a function returning `void`, its handler may still return a value; the encoding drops it. Declare `success` to return data.
- `input` and `success` take a schema or fields. Fields become `Schema.Struct(fields)`, and no fields the empty object above; each field must be service-free, like every schema here. A schema is kept as given: a `Schema.Struct({})` accepts any value but `null`, as in Effect, and MCP refuses it as a tool's input, so write `{}` instead.
- `errors` is a list of schemas, default none. Each keeps its own `httpApiStatus` annotation, and so does each member of a union without one of its own. An unannotated error is served as HTTP 422: an expected outcome, not Effect's default 500, which reads as a server fault.
- To share errors across actions, spread one constant array into each action's `errors`.
- `caller` is required: `Action.Anyone`, or the identity service a caller must have. An action whose `caller` is `Action.Anyone` is a public action, any other a protected one. There is no default, so an action nobody classified fails to compile rather than being served to anyone; `make` also throws without it, for a caller the compiler never sees.
- A protected contract imports its identity, so the module declaring it stays browser-safe: a `Context.Service` and its type, without the verifier ([setup.md](setup.md#browser)). Never a `Context.Reference`: its default is always present, so it would stand in for every caller who supplies none; the types refuse one, and `make` throws. A contract never imports a transport, its authentication descriptor included.
- One identity per action, and every protected action one remote surface serves declares the same one, its authentication descriptor's. A tenant or other request context is an ordinary request-time requirement of the handler, never a second identity.
- Every surface enforces `caller`, whatever the handler reads: a protected action is authenticated remotely and owes its identity per call locally, even where its handler and authorizer read none ([guarantees.md](guarantees.md#authorization)). A public action is neither authenticated nor authorized, and no surface provides it an identity: a public handler that reads one leaves its layer owing it ([Failure modes](#failure-modes)). An action whose answer depends on the caller is protected.
- `checks` lists the action's checks, run in that order after authorization; each one's `error` joins `errors`, deduplicated, so do not list it there too ([Checks](#checks)).
- `readOnly` is a boolean and is required: whether the action leaves its resource unchanged. `make` also checks it at runtime, so a caller the compiler never sees cannot define an action no rule classifies. It stays a literal on the action, so a type may select the read-only actions, `Extract<A, { readonly readOnly: true }>`.
- An implementation's `authorize` reads `readOnly` ([guarantees.md](guarantees.md#authorization)); the library itself authorizes nothing with it. Its only built-in uses are the tool's hints and the span/log annotation.
- `readOnly` is also the tool's read-only hint, which no option overrides, so authorization and what MCP clients are told cannot disagree. Derive authorization from `readOnly`, never from an `mcp` hint.
- A contract says nothing about where it is served. Each surface takes the list of actions it serves, from the implementations passed to it: HTTP its binding's, `ActionHttp.make(actions)`, and MCP, a Toolkit and `ActionCli.make` their `actions` option, or every action of the implementations without it. To keep an action off a surface, leave it out of that list, whatever implementation holds it. A listed action keeps its `caller`, its checks, its implementation's authorizer and its builder's one run.
- List the actions that are tools in one place, beside the contracts, `export const Tools = [GetUser, RenameUser] as const`, and give every MCP endpoint and Toolkit `actions: Tools`: an action added later is no tool until it is listed. List an action only where the model may hold what it takes and returns: a tool call passes both through the model's context, and records its input on a span ([guarantees.md](guarantees.md#observability)).
- `byName(actions)` keys a list by name: `const contracts = Action.byName(Actions)` gives `contracts.getUser`, its schemas for a test or a mock, `keyof typeof contracts` as the names, and an action's types by name, `(typeof contracts)[K]["input"]["Type"]`, which resolves under a generic `K`, where `Extract` over the list does not. The list is typed by its members ([guarantees.md](guarantees.md#names)). It throws `Duplicate action: <name>` for a name held twice.
- `make` accepts only the keys listed above, and `mcp` only `title`, `destructiveHint`, `idempotentHint`, `openWorldHint`, `_meta` and `text`: MCP's own names, and the library's `text`. An unknown key is a compile error, beside known ones too, and so is `readOnlyHint`. `text` names a top-level string field of the encoded success, which MCP sends as text ([ActionMcp.md](ActionMcp.md#text-fields)); every other surface ignores it. `title` is the tool's display name, MCP's `annotations.title`, and `_meta` its `_meta`, sent as given, such as an MCP App's UI resource: native `Tool.Title` and `Tool.Meta` on a Toolkit's tool. Neither has a default, and neither is sent when left out.
- An `undefined` option takes its default, as an omitted one does. One that may be either is typed as either: with `success: enabled ? Schema.String : undefined`, or the same through a conditional spread, the success is `string | void`. The same holds for `input` and `errors`.
- Options typed as a whole (`Parameters<typeof Action.make>[1]`) are not checked. Their action's schemas are as wide as what may run, so its success is `unknown`.
- MCP input must be one object with keys, an identified, recursive or suspended root included. Scalar, array or union input is fine for HTTP and for a native Toolkit, but `ActionMcp` refuses it when `layerHttp` or `runStdio` is called, naming the action ([ActionMcp.md](ActionMcp.md#rules)). Success and error schemas may be any shape.
- The contract keeps `mcp` as given, `action.mcp`, and defaults none of it. A hint left out is not annotated, so the native default, MCP's, stands: `destructiveHint` `true`, `idempotentHint` `false`, `openWorldHint` `true`; but a read-only action's `destructiveHint` is `false` unless it states one. A stated hint is sent as it is, a read-only action's included, which MCP reads only for a tool that is not read-only. `readOnlyHint` is always `readOnly`. Hints are metadata for the model. They do not enforce authorization, approval, or retries; a native Toolkit's approval is `ActionToolkit.make`'s `needsApproval` option.
- The built-in errors are declared everywhere ([guarantees.md](guarantees.md#wire-behavior)), and any handler may fail with them without listing them: `InvalidInput` for input that decodes but cannot be served, naming `issues` of its own as the library's do ([guarantees.md](guarantees.md#wire-behavior)), `new Action.InvalidInput({ message, issues: [{ path: ["lines"], message }] })`, so an application declares no second error for bad input; a refusal for a step-up. `make` refuses an `errors` entry that encodes with a built-in tag, the built-in itself included, since every surface declares it already and a client could not tell a look-alike apart.
- Code that decodes input of its own, such as a header, a route parameter or a file's metadata, answers a failure as the surfaces do with `Action.InvalidInput.fromSchemaError(error)`: the schema's message and its `issues`, `Effect.mapError(Action.InvalidInput.fromSchemaError)` after a `Schema.decodeUnknownEffect`. To place the issues under a field of a larger input, map their `path`s.
- Build a refusal with or without a message: `new Action.Forbidden()` sends `"Not allowed."`, `new Action.Forbidden({ message: "Requires users:write." })` sends that. A `Forbidden` may name the OAuth scopes the call lacks, `new Action.Forbidden({ scopes: ["users:write"] })`: a refused OAuth client then re-authorizes with them ([Authentication.md](Authentication.md#rules)).
- Schemas must be service-free. Put service access in the handler.

### Implementations

- `implement` returns one `Implementation` of everything it binds: `implement(action, handler, options)` one action, `implement([a, b], { a: ..., b: ... }, options)` every listed action. Either may take an Effect that builds the handler or the record instead. One implementation may hold public and protected actions. Every surface takes one implementation or a list: `[status, userActions, double]`. Which actions it exposes follows the [surface selection rules](guarantees.md#names).
- An implementation holding a protected action states who of the authenticated callers may call: `{ authorize }` is required, and leaving it out is a compile error. `Action.allowAll` lets every authenticated caller call; authentication still decides who that is. An authorizer that depends on the deployment is `enabled ? authorize : Action.allowAll`; its services are owed either way. Plain JavaScript has no types, so `implement` also checks at runtime that it got one.
- An implementation of public actions alone takes no options: `{ authorize }` there is a compile error, since nothing would run it.
- `authorize` runs only for protected actions, after authentication and input decoding, before the checks and the handler, on every surface ([guarantees.md](guarantees.md#authorization)). It fails only with a refusal: a limit, or any other failure a caller should see beside a refusal, is a [check](#checks). Typed `Action.Authorize<Action.Any>`, an authorizer fits every implementation, as `Action.allowAll` does.
- `authorize` may be an Effect that builds it, as a builder builds handlers ([Built authorization](#built-authorization)). Its lifetime, and startup versus request-time services: [guarantees.md](guarantees.md#dependency-lifetimes). Guarding several implementations, it is built once for each: keep state they share in a service the Effect yields, or pass a service whose value is the authorizer itself, `{ authorize: Guard }`, which Effect builds once. `Effect.isEffect` tells the two forms apart, so an authorizer written with `Effect.fn` is a plain one.
- `authorize` sees `action` typed as the implementation's own actions when it is written in `implement`'s options, as a plain function, an `Effect.fn` or a built one. Defined apart, as a rule several implementations share is, nothing types it there: annotate it, `(action: Action.Any)`.
- A record has exactly one own-property function per action, keyed by its name. Missing and extra keys are compile errors, for a plain record and for a builder's. An inherited method does not count. Handlers are called without a receiver. Duplicate action names in one call throw at `implement`.
- A plain handler or record is checked at `implement`; a builder's record when it is built. A record that slips past the types (plain JavaScript, a cast) throws `Unknown handlers` for a key no action names, and `Missing handlers` for an action without a function. From a builder, the layer build dies with the same message. Nothing is served with a handler missing.
- Builder lifetime and build-time versus request-time services: [guarantees.md](guarantees.md#dependency-lifetimes). Authentication, authorization and checks: [guarantees.md](guarantees.md#authorization). Surfaces keep the two kinds of services separate in their types, per action.
- A handler's input is typed from its action however it is written: an arrow, a function typed `Action.Handler`, or a generator, `Effect.fn(function* (input) { ... })` or `Effect.fnUntraced`, alone or in a record, a builder's included. The builder must itself be `implement`'s argument: through `.pipe(...)`, or a wrapper such as `Effect.withSpan(builder, name)`, an `Effect.fn` it returns takes an `any` input, so annotate the input there.
- Each handler already runs in a span named after its action, and every log line it writes is annotated with `action.name` and `action.read_only` ([guarantees.md](guarantees.md#observability)). Leave `Effect.fn` unnamed: don't wrap a handler in `Effect.fn(name)` or annotate its logs with the action's name yourself.
- A surface serves fewer of an implementation's actions through its own list ([Contracts](#contracts)), and `client` through `actions`: each listed action keeps its implementation's handlers, builder, authorizer and checks. Selection never changes who may call. A caller trusted on one surface, such as an operator on an admin CLI, is an identity the host supplies there, which the same authorizer admits ([ActionCli.md](ActionCli.md#trusted-callers)). Another authorizer for the same handlers takes another `implement`, of the same builder Effect, which then runs once per implementation in each layer graph. A builder written apart from `implement` returns its record `satisfies Action.Handlers<typeof actions>`, so each handler is typed from its contract, as inside `implement`.
- A helper over implementations is generic, `<const Apps extends Action.AnyImplementation | ReadonlyArray<Action.AnyImplementation>>(apps: Apps)`, so each implementation's requirements reach the surface it passes them to, `ActionHttp.layer` included, whose binding decides what it serves. Beside the helper's own implementations, list or spread the parameter, `[app, double]` or `[...apps, double]`. `AnyImplementation` erases every channel to `unknown`: a value or a parameter typed with it owes `unknown`, which no surface can be given. An implementation's own type is inferred from `implement`: `Implementation`'s type parameters are not meant to be written out, and change as its channels do. Exported from a package that emits declarations, the helper states its return type as the surface's own, `ReturnType<typeof Action.client<Apps>>`, which TypeScript can name where the inferred one cannot.
- `Implementation` is nominal. Spreading its properties does not produce an implementation. Surfaces match an implementation to an action by object identity, so implement the exact contract value a binding or a CLI selector receives.
- Test what an implementation does, its authorizer, its checks and its handlers, in process with `client`, each caller provided around its own calls ([Clients](#clients)); test what a surface adds, authentication, statuses and codecs, under `Testing.layer` ([Testing.md](Testing.md)). A builder's handlers exist only once it runs, so calling the function passed to `implement` works only for a plain handler, and skips authorization and every check. Cover each surface the application exposes.

### Checks

- A check is declared once, `class Limited extends Action.Check<Limited>()("example/Limited", { error, requires })`, a transport-free value contracts list, safe in a browser as a contract is. `error` is one codec, which may be a union; `requires` is the request service the check reads per call, `requires: CurrentActor`, or several, `requires: [CurrentActor, Tenant]`, optional. Each call of an action listing it owes every one. Its name is a service key's: one declaration per name.
- An action lists a check once: `make` drops a repeat, such as one a spread shared list adds, so it runs once per call.
- Each action listing it declares its `error`: `make` adds it to the action's `errors`, deduplicated, so every surface declares it for that action and every client decodes it, as any declared error ([guarantees.md](guarantees.md#authorization)). A check reaching the HTTP binding's `errors` instead is not one: those are router middleware's.
- A native layer implements it: `Layer.succeed(Limited, callback)` with the callback itself, `(action) => Effect<void, error, requires>`. A callback that reads a startup service, such as the limiter, is built instead: `Layer.effect(Limited, build)`, where `build` is an Effect returning the callback, built once per layer graph, as a built authorizer is, and what it yields is a startup service. The callback fails only with the declared `error` and reads per call only the declared `requires`: either otherwise is a compile error.
- The callback may use the call's own `Scope`, `Effect.addFinalizer` or `Effect.acquireRelease`: it is released when the call ends, whether the check refused it or the handler ran, and no caller owes `Scope`.
- The callback receives the action, never its input: a rule on the input, or on one record, is the handler's. To apply a check to only some actions, list it only on those, or switch on `action` in the callback.
- Checks run for public and protected actions alike, after authorization and before the handler, in the order the action lists them. A failing check ends the call; the handler never runs. A check's error is not a refusal, as `make` refuses a built-in `_tag`; a check whose error schema admits a refusal, and that fails with one anyway, is answered as that refusal, stepping up under a Bearer descriptor as a handler's does ([guarantees.md](guarantees.md#authorization)).
- A check whose `requires` is the identity applies to protected actions alone: a public action listing it owes the identity per call, which no remote surface provides it.
- Every surface serving an action that lists a check requires the check's layer at startup, as it requires a builder's services: `Layer.provide(LimitedLive)` to an HTTP or MCP layer, `Command.provide(LimitedLive)` on a CLI command, `Effect.provide` around a Toolkit's layer or an `Action.client` acquisition; `layer(implementations)`, which runs builders alone, does not. Provide it once above every surface, so all of them count against one state ([dependency lifetimes](guarantees.md#dependency-lifetimes)).
- A check runs after decoding, so input that does not decode never counts, and a protected request without a valid credential never reaches it. A limit counting every request is router middleware over HTTP ([guarantees.md](guarantees.md#authorization)).
- An authorizer that also limited splits into `authorize`, which refuses, and a check, which limits.

### Clients

- `client(implementations)` takes one implementation or a list, as a surface does, and gives one method per action, named after it and taking its input directly: the methods `ActionHttp.client` gives, so moving between an in-process and a remote caller changes the line acquiring it. The argument may be left out when `{}` is a valid encoded input, such as an input whose every field has a decoding default, and is then what `{}` decodes to; an input whose encoded form requires a field its decoded one lacks takes the argument. Every implemented action has a method, whether or not a surface serves it. An action name twice among the implementations throws `Duplicate action: <name>` where `client` is called.
- A call runs as a remote one does, through the dispatch every surface shares. Its input passes through its JSON codec, encoded to JSON text then decoded, so the handler receives what a remote handler decodes: an undeclared field dropped, as a client's encoding drops it, a class instance built anew, a decoding transformation such as a trim applied, `0` for `-0`. Authorization runs, then the checks, then the handler, in its action's span, each call in a scope of its own ([guarantees.md](guarantees.md#dependency-lifetimes)). The success passes through its codec the same way, and a failure through the codec of every error the action declares, the built-in ones included, so the caller gets what a remote caller decodes: no undeclared field, a decoding transformation applied, `undefined` for a `Schema.Void` success. A failure keeps its trace: where the authorizer, a check or the handler failed.
- A call fails with the action's declared errors and the built-in ones, as `ActionHttp.client` decodes them, and with nothing of a transport. Input that does not pass through its codec is `InvalidInput`, with the schema's message and `issues`, and authorization, the checks and the handler never run; a class input is passed as an instance, as over HTTP. A protected action's call without its identity fails with `Unauthenticated` before the authorizer runs. The authorizer's refusal, or a check's declared error, is the call's failure. A success or a failure that does not pass, an error the action does not declare included, is a defect, as it is an empty 500 over HTTP: the handler broke its contract. The defect is its `SchemaError`, and for a failure, the failure itself after it.
- Each method owes, per call, what its handler, its implementation's authorizer and its checks read, and a protected action's identity whether or not they read it, and the caller provides them around the call, or around a program making several: `users.renameUser(input).pipe(Effect.provideService(CurrentActor, actor))`. A call reads its caller's context, never the one the client was acquired in: provided around the acquisition, a service reaches no call, so neither does a startup identity, and one client serves every caller.
- `actions` lists the actions it calls among the implementations', as a surface's `actions` does: an implementation holding none of them is left out, unbuilt, and a listed action none of them holds throws `Listed in actions, but no implementation holds it: <names>`. Where `actions` may be absent, an optional property or a union with options lacking it, the client offers methods only for the actions it may list, which are present either way, while it owes and builds what every action needs ([guarantees.md](guarantees.md#names)). An explicit type argument listing actions requires the options argument.
- Acquiring a client builds its implementations' builders, every authorizer an Effect builds, and requires the checks of the actions it calls, as a layer does: the acquisition owes their startup services, the check layers and a `Scope`, and fails as they fail; no call does. Where it builds, and what it shares: [dependency lifetimes](guarantees.md#dependency-lifetimes). Acquire it where builders live, once: in a builder, in a layer providing it as a service of type `Action.Client<typeof users>`, or in a scoped program, such as a test, a job or a command. Never per request, in a handler.

## Failure modes

- `Invalid action name: <name>` thrown by `make`: the name is empty, longer than 128 characters, `then`, or has another character.
- `Invalid readOnly: <value>` thrown by `make`: `readOnly` is not a boolean, which only a caller the compiler never sees can pass.
- `Property 'caller' is missing` at `make`, or `Missing caller: declare Action.Anyone or an identity service key` thrown by `make`: the contract does not state who may call it. Give `caller: Action.Anyone`, or the identity service a caller must have. There is no default.
- `Type ... is not assignable to type '"An identity is a Context.Service, not a Context.Reference"'` at `make`, or `Invalid caller: an identity is a Context.Service, not a Context.Reference` thrown by `make`: `caller` is a `Context.Reference`, whose default would authenticate every caller. Declare the identity with `Context.Service`.
- `... is not assignable to parameter of type 'ProtectedActionsTakeAuthorize'` at `implement`, ending `Type 'typeof CurrentActor' is not assignable to type 'unique symbol'`: the target holds a protected action, and the implementation states no `authorize`. Pass `{ authorize }`, or `{ authorize: Action.allowAll }` where every authenticated caller may call.
- `No overload matches this call` at `implement`, ending `... is not assignable to type '"A public-only target takes no authorize"'`: an implementation of public actions alone states `authorize`, which nothing would run. Drop it; a public action is never authorized. If the action needs a caller, make its contract protected. Plain JavaScript passing one throws `A public-only target takes no authorize` at `implement`.
- `Protected actions require authorize, or Action.allowAll` thrown at `implement`: plain JavaScript left `authorize` out for a target holding a protected action. `Missing authorize: pass an authorization function, or Action.allowAll` thrown at `implement`, or the layer build dies with it: `authorize` is neither a function nor an Effect building one, or that Effect built something else.
- `Argument of type '... | undefined' is not assignable` at `implement`'s `authorize`: an authorizer that may be `undefined`, such as `enabled ? authorize : undefined`. Write `enabled ? authorize : Action.allowAll`.
- `Parameter 'action' implicitly has an 'any' type`, or an `Effect.fn` authorizer whose `action` is `any`, where it is defined apart from `implement`: nothing types it there. Annotate it, `(action: Action.Any)`.
- Type error `Effect<..., X, ...> is not assignable` at `implement`: the handler fails with an undeclared error `X`. Add it to the action's `errors` or handle it.
- `Type 'X' is not assignable to type 'Refusal'` at `implement`, ending in a `_tag` mismatch with `"Unauthenticated"`: the authorizer fails with `X`, which is not a refusal. A limit or another failure callers should see is a check: declare it, list it on the actions, and fail with `X` there ([Checks](#checks)).
- `... is not assignable to type 'CheckCallback<E, R>'` at `Layer.succeed` or `Layer.effect`, such as `Property 'retryAfter' is missing in type 'X' but required in type 'RateLimited'`: the callback fails with an error other than its declaration's `error`, or reads a service its `requires` does not name. Fail with the declared error, or widen the declaration's `error` to a union; add the service to `requires`, a list for several.
- `Limited` among a layer's, a command's or a program's unprovided requirements, such as `Type 'Limited' is not assignable to type 'never'` where it is launched or run: an action it serves lists the check, and its layer is not provided. Provide `LimitedLive`, `Layer.effect(Limited, build)`, once above every surface.
- `Type 'CurrentActor' is not assignable to type 'never'`, or `Request<"Requires", CurrentActor>` still owed, for a layer serving only public actions: a public action lists a check requiring the identity, or its handler reads it, and no surface provides an identity to a public action. List the check on protected actions only, or make the action protected.
- `Property 'x' is missing in type` at `implement`: the record lacks a handler for action `x`.
- `Missing handlers: <names>` at `implement`, or when a builder's layer builds: the record has no own-property function for those actions. Add them to the record itself, not to a prototype.
- `Unknown handlers: <keys>` at `implement` or when a builder's layer builds, or a type error names a key: the record has a handler for an action not in this `implement` call. Remove it, or add its action to the list.
- `Listed in actions, but no implementation holds it: <names>` thrown by `client`: a listed action is none of the implementations'. Pass the implementation holding it, or check the contract values are the ones it implemented.
- `Duplicate action: <name>` at `implement`: the list names one action twice. Thrown by `client`: two of its implementations implement an action of that name. Separate contracts sharing a name are told apart by `actions`, listing one; two implementations of the same contract are not, since listing it keeps both: pass one implementation.
- Handler receives a string where a number was expected: the schema is `Schema.String`, not a transforming codec such as `Schema.FiniteFromString`.
- `Property 'readOnly' is missing` at `make`: every action declares whether it is read-only. There is no default.
- A service is resolved once and shared across requests when it should be per request: it was yielded in the builder, or in the Effect building the authorizer or a check. Move the `yield*` into the handler, the authorizer or the check's callback. An identity yielded there is a startup requirement of the layer; never provide one at startup ([guarantees.md](guarantees.md#dependency-lifetimes)).
- `HttpRouter.Request<"Requires", X>` still owed, or `Type 'X' is not assignable to type 'never'` at `runMain`, although `X`, a store the authorizer reads, is provided at startup: the authorizer yields it on every call. Yield it in an Effect that builds the authorizer ([Built authorization](#built-authorization)).
- `unknown` among a surface's requirements, and a type error where it is served or run, such as `Argument of type 'Layer<never, unknown, unknown>' is not assignable` at `HttpRouter.toWebHandler` or `Type 'unknown' is not assignable to type 'never'` where it is launched or run: the implementations are typed `Action.AnyImplementation`, as a helper's parameter or a list's annotation. Make the helper generic over them, or drop the annotation.
- `Request<"Requires", unknown>` in a type error where an implementation is served, or `unknown` among the services a call or a run still requires: TypeScript inferred no requirements for a handler of a record. A data-first call whose type takes a parameter from no argument does it, `Effect.catchTag(effect, tag, f)` for one, where `Effect.catch`, `Effect.map` and `Effect.orDie` do not. Write that handler's Effect `effect.pipe(Effect.catchTag(tag, f))`, or as a generator.
- `'readOnlyHint' does not exist in type 'Mcp'` at `make`, or `Type 'true' is not assignable to type 'never'` on `readOnlyHint` beside another hint: a tool's read-only hint is its action's `readOnly`. Set `readOnly` instead.
- `Type '...' is not assignable to type 'never'` on a key at `make`, in `mcp` too: an option or hint it does not take, or a misspelled one, such as `destructive` for `destructiveHint`.
- `Type 'H' is not assignable to type 'H & ...'` at `make`, where `H` is a helper's type parameter, as in `<const H extends Action.Mcp>(mcp: H)`: the check cannot read options a type parameter stands for, so it refuses them. An action's type carries no `mcp` types, so type the parameter `Action.Mcp`; the helper loses nothing.
- Type error on `errors` at `make`, `... is not assignable to type 'readonly never[]'` or naming the remaining errors: it lists a built-in error. Drop it; every surface declares it, and a handler may fail with it anyway.
- `make` throws `Action "<name>": error _tag "Forbidden" is built in, and declared on every surface`: an error in the action's `errors`, or a member of a union there, encodes with the `_tag` of a built-in error, `InvalidInput`, `Unauthenticated` or `Forbidden`. Drop a built-in error from `errors`, since a handler may fail with it anyway; rename an error of your own.
- `ReferenceError` thrown by `make`: an entry of `errors` is a `Schema.suspend` whose thunk reads a `const` declared further down. `make` reads every error's `_tag` when it is called; declare the error first.
- `Type 'CurrentActor' is not assignable to type 'never'` where a program calling a client runs: a call of a protected action owes the caller, and nothing provides one around it. Provide it around the call, or around the calls it makes; provided around the acquisition, it reaches no call. Never provide it to a layer or a builder acquiring the client.
- A type error that a program still requires `Scope`: acquiring a client builds, as a layer does. Acquire it in a builder or a layer, or run the program in `Effect.scoped`.
- A builder runs on every request, or a route owes `HttpRouter.Request<"Requires", X>` for `X`, a service its builder yields: a handler acquires a client per request. Acquire it in the builder, and call it in the handler.
- A builder runs twice, or a job, an agent or a second server reads other state than the routes, such as an empty in-memory store: it is merged beside `HttpRouter.serve`, whose layer graph built the builder first. Put it inside the layer the server serves, or provide `Action.layer` and the services they share above both ([dependency lifetimes](guarantees.md#dependency-lifetimes)).
- Surfaces given startup services of their own, provided around each or to an `Action.layer` of each, all answer with one surface's: a builder runs once per layer graph, with the services of its first build. Wrap each surface in `Layer.fresh`, or give each an implementation of its own ([dependency lifetimes](guarantees.md#dependency-lifetimes)).
- `'<name>' implicitly has type 'any' because it does not have a type annotation and is referenced directly or indirectly in its own initializer` (TS7022) at `implement`, or, with the types bypassed, an acquisition that never completes: a builder acquires a client of its own implementation, directly or through another builder. Call the services both use instead.
- A call dies with a `SchemaError`: the handler's success, or what the handler fails with, does not pass through its codec, which an HTTP caller sees as an empty 500. A failure follows the `SchemaError` in the cause, as `Cause.pretty` shows. Return what the success schema accepts, and fail with an error the action declares, as its schema accepts it.
- `InvalidInput` with `Expected <Class>` from a call given a plain object: the input is a class, which encodes only its instances. Pass `new Class({ ... })`, or leave out an argument whose fields are all optional.
- `Not an implementation made by this Action.implement: is effect-actions installed twice?` thrown by a surface, `client` or `layer`, or by a local CLI command when it runs: another installed copy of the package made the implementation, and only that copy serves and calls it. Install one copy of the package; contracts and bindings still cross copies.
