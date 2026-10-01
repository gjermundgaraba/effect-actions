# Action

One contract: a name, schemas for input, success and declared errors, `access`, and tool
hints. A contract holds no behavior; `implement` binds handlers to contracts, with the hook every
surface runs before them: whether a caller may call. Every implementation states it, if only as
`Action.allowAll`. Every surface that runs handlers takes an implementation or a list of them,
and so does `client`, which calls them in process with the methods `ActionHttp.client` has.
The module also exports the built-in errors every surface declares and any handler may fail
with.

## API

Import `@gjermundgaraba/effect-actions/Action`.

| Export                                         | Purpose                                                                                |
| ---------------------------------------------- | -------------------------------------------------------------------------------------- |
| `make(name, options)`                          | Define a pure contract; literal names and access stay typed.                           |
| `implement(action, handler, before)`           | Bind one handler behind its hook; returns one `Implementation`.                        |
| `implement([actions], handlers, before)`       | Bind a record of handlers keyed by action name; returns one `Implementation` of all.   |
| `implement(target, builder, before)`           | Either form, with an Effect that builds the handler or record once per layer graph.    |
| `allowAll`                                     | The hook for no action-level rule: every caller the surface admits may call.           |
| `share(target, implementation, before?)`       | Some of an implementation's actions, sharing its builder, behind its hook or `before`. |
| `layer(implementations)`                       | Their builders as one layer: provided above every surface, each runs once for all.     |
| `client(implementations)`                      | An Effect of a caller running them in process: `client.<action>(input)`.               |
| `InvalidInput`, `Unauthenticated`, `Forbidden` | Built-in errors: 400, 401, 403, body `{ _tag, message }`; `message` defaults.          |
| `Refusal`                                      | `Unauthenticated \| Forbidden`: what authentication or a `before` hook refuses with.   |
| `BuiltIn`                                      | `InvalidInput \| Refusal`: what any handler may fail with beyond its `errors`.         |
| `Action`, `Any`, `Implementation`              | Concrete and erased contracts, and bound implementations.                              |
| `Client<Apps>`                                 | What `client` gives for the implementations `Apps`, one or a list.                     |
| `AnyImplementation`, `AnyImplementation<A>`    | Any implementation, or any of actions `A`, erased: a generic helper's constraint.      |
| `implementation.actions`                       | Its exact contract values, as `Testing.mcpClient(users.actions)` takes them.           |
| `Handler`, `Before`, `Access`                  | Typed handlers, hooks `(action) => Effect<void, Refusal \| E, R>`, `"read"`/`"write"`. |
| `Options`, `Hints`                             | What `make` takes, and its tool hints.                                                 |

| Option                  | Meaning                                                          |
| ----------------------- | ---------------------------------------------------------------- |
| `description`, `access` | Required description and `"read"` / `"write"`.                   |
| `input`                 | Optional schema or fields; omitted or `{}`, an empty object.     |
| `success`               | Optional schema or fields; omission means `Schema.Void`.         |
| `errors`                | Declared error codecs; defaults to none.                         |
| `hints`                 | Tool hints for MCP and the Toolkit; each defaults from `access`. |

`before` is required. It receives the selected action and fails with a `Refusal`, or with an
error `E` every action of its implementation declares, such as a rate limit; every surface runs
it ([guarantees.md](guarantees.md#authorization)). It may instead be an Effect that builds it,
as a builder builds handlers. Authentication is the host's, not the implementation's
([Authentication.md](Authentication.md)).

`input` and `success` take a schema or plain fields: `{ id: Schema.String }` is
`Schema.Struct({ id: Schema.String })`. A tool is read-only exactly when `access` is
`"read"`. Hints: `destructive`, a write's only, defaults to `true`; `idempotent` to `false`;
`openWorld` to `true`. The tool is named after the action. Handlers receive decoded input and return decoded success, failing only
with declared errors and the built-in ones.

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

### Identity and hook

The module the implementations, the authentication and every local caller import: the
identity, `CurrentActor`, which authentication provides per request, and the hook,
`authorize`, which reads each action's `access`. Its demo actors stand in for the identities a
token verifier returns.

```ts
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

/** Provided per request by the host's authentication middleware. */
export class CurrentActor extends Context.Service<CurrentActor, Actor>()("example/CurrentActor") {}

/**
 * One authorization rule for every guarded surface, derived from each contract's own
 * `access`. An implementation binds it as its `before` hook, so every surface serving it
 * runs it before every handler and no handler contains authorization code. Its `Forbidden` is
 * built in: every endpoint and tool declares it, and every client decodes it. Naming the
 * missing scope makes it the `insufficient_scope` challenge an OAuth client steps up on.
 */
export const authorize = Effect.fn("authorize")(function* (action: Action.Any) {
  const permission: Permission = action.access === "read" ? "users:read" : "users:write";
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
(`CurrentActor`) inside handlers. `authorize` is the hook every surface runs before each
handler; the authentication provided around the HTTP surfaces supplies `CurrentActor`. The
public `status` states `Action.allowAll` instead. Every surface takes one implementation or a
list: `double`, `userActions`, `[userActions, double]`. Implementations group actions by domain,
not by surface: `userActions` holds `listChanges`, which HTTP does not serve because its
binding leaves it out. A layer without authentication still takes only public actions
([ActionHttp.md](ActionHttp.md#rules)).

```ts
import { Effect } from "effect";
import * as Action from "@gjermundgaraba/effect-actions/Action";
import { authorize, CurrentActor } from "./authorization.js";
import { Double, GetUser, ListChanges, RenameUser, Status, WhoAmI } from "./contracts.js";
import { Users } from "./users.js";

// Every caller may call, and it owes nothing per request: public wherever no
// authentication covers it.
export const status = Action.implement(
  Status,
  Effect.gen(function* () {
    const users = yield* Users;

    return () => Effect.map(users.count, (count) => ({ service: "effect-actions", users: count }));
  }),
  Action.allowAll,
);

// Capture Users at startup; resolve CurrentActor per request. Every surface runs the
// `authorize` hook before each handler, so it has already refused an actor without the
// permission the action's access needs. HTTP serves only the actions its binding holds:
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
  authorize,
);

// Pure: no builder and no services, only the hook.
export const double = Action.implement(Double, ({ value }) => Effect.succeed(value * 2), authorize);
```

### Built hooks

A hook that reads a startup service, such as a permission store, is built as handlers are: an
Effect yields the store once and returns the hook, which yields the caller on every call.
The host provides `Permissions.layerMemory` at startup, as it provides `Users`; authentication
still provides `CurrentActor` per request.

```ts
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
// provided next to `Users`, and the hook it returns yields the actor on every call.
export const authorizeStored = Effect.gen(function* () {
  const permissions = yield* Permissions;

  return (action: Action.Any) =>
    Effect.gen(function* () {
      const permission: Permission = action.access === "read" ? "users:read" : "users:write";
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
  authorizeStored,
);
```

### Client

Implementations called in process, by code: a test, a job, a command of your own. The client is
acquired once, where builders live, and each call is given its caller, as authentication gives
one per request, so one client serves several callers. Every implemented action has a method,
`listChanges` included, which no binding holds.

```ts
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
  // its input, runs the hook, then the handler, and checks the success or the failure.
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
- `access` is `"read"` or `"write"` and is required. `make` also checks it at runtime, so a caller the compiler never sees cannot define an action no rule classifies. It stays a literal on the action, so a rule may switch on it at the type level.
- An implementation's `before` hook reads `access` ([guarantees.md](guarantees.md#authorization)); the library itself authorizes nothing. Its only built-in uses are default hints and span/log annotations.
- `access` is also the tool's read-only hint, which no option overrides, so authorization and what MCP clients are told cannot disagree. Derive authorization from `access`, never from a tool hint.
- A contract says nothing about where it is served. HTTP serves its binding's actions among the implementations passed to it; MCP, a Toolkit and `ActionCli.make` serve every action of theirs. To keep an action off HTTP, leave it out of `ActionHttp.make`, whatever implementation holds it; to keep it off MCP, leave its implementation out of the MCP layer.
- An action kept off MCP, a Toolkit or a CLI this way, but sharing a builder with served ones, is `share`d from their implementation, so the builder still runs once. HTTP needs no `share`: its binding already leaves the action out. List the actions that are tools in one place, beside the contracts, `export const Tools = [GetUser, RenameUser] as const`, and give every MCP endpoint and Toolkit `share(Tools, users)`: an action added later is no tool until it is listed. List an action only where the model may hold what it takes and returns: a tool call passes both through the model's context, and records its input on a span ([guarantees.md](guarantees.md#observability)).
- `make` accepts only the keys listed above, and `hints` only `destructive`, `idempotent` and `openWorld`. An unknown key is a compile error, beside known ones too.
- An `undefined` option takes its default, as an omitted one does. One that may be either is typed as either: with `success: enabled ? Schema.String : undefined`, or the same through a conditional spread, the success is `string | void`. The same holds for `input` and `errors`.
- Options typed as a whole (`Parameters<typeof Action.make>[1]`) are not checked. Their action's schemas are as wide as what may run, so its success is `unknown`.
- MCP input must be one object with keys, an identified or recursive root included. Scalar, array or union input is fine for HTTP and for a native Toolkit, but `ActionMcp` refuses it, with a type error naming the action ([ActionMcp.md](ActionMcp.md#rules)). Success and error schemas may be any shape.
- Hint defaults: `destructive: access === "write"`, `idempotent: false`, `openWorld: true`; `readOnlyHint` is always `access === "read"`. Only a write may state `destructive`: a read is never destructive, as MCP defines the hint for writes only. Hints are metadata for the model. They do not enforce authorization, approval, or retries; a native Toolkit's approval is `ActionToolkit.make`'s `needsApproval` option.
- The built-in errors are declared everywhere ([guarantees.md](guarantees.md#wire-behavior)), and any handler may fail with them without listing them: `InvalidInput` for input that decodes but cannot be served, a refusal for a step-up. `implement` refuses an `errors` entry that encodes with a built-in tag, the built-in itself included, since every surface declares it already and a client could not tell a look-alike apart.
- Build a refusal with or without a message: `new Action.Forbidden()` sends `"Not allowed."`, `new Action.Forbidden({ message: "Requires users:write." })` sends that. A `Forbidden` may name the OAuth scopes the call lacks, `new Action.Forbidden({ scopes: ["users:write"] })`: a refused OAuth client then re-authorizes with them ([Authentication.md](Authentication.md#rules)).
- Schemas must be service-free. Put service access in the handler.

### Implementations

- `implement` returns one `Implementation` of everything it binds, behind its hook: `implement(action, handler, before)` one action, `implement([a, b], { a: ..., b: ... }, before)` every listed action. Either may take an Effect that builds the handler or the record instead. Every surface takes one implementation or a list: `[userActions, double]`. Which actions it exposes follows the [surface selection rules](guarantees.md#names).
- Every `implement` states who may call: `before` is required, and leaving it out is a compile error. `Action.allowAll` is the hook without an action-level rule: every caller a surface admits may call, and authentication around the surface still decides who that is. A hook that depends on the deployment is `enabled ? authorize : Action.allowAll`; its services are owed either way. Plain JavaScript has no types, so `implement` also checks at runtime that it got a hook.
- `before` fails with a refusal, or with an error every action of its implementation declares: spread one array, `const limits = [RateLimited] as const`, into each action's `errors`, and the hook's `new RateLimited({ retryAfter: 30 })` reaches every surface as the called action's own error ([guarantees.md](guarantees.md#authorization)). An action added to the implementation without it is a type error. One action's hook may fail with any error of its own, and a `share`'s with what its own actions declare in common. Typed `Action.Before<Action.Any>`, a hook knows no action's errors, so it only refuses.
- `before` may be an Effect that builds the hook, as a builder builds handlers ([Built hooks](#built-hooks)). Its lifetime, and startup versus request-time services: [guarantees.md](guarantees.md#dependency-lifetimes). Guarding several implementations, it is built once for each: keep state they share, such as a rate limiter's counts, in a service the Effect yields, or pass a service whose value is the hook itself, `implement(actions, handlers, Guard)`, which Effect builds once. `Effect.isEffect` tells the two forms apart, so a hook written with `Effect.fn` is a plain one.
- A record has exactly one own-property function per action, keyed by its name. Missing and extra keys are compile errors, for a plain record and for a builder's. An inherited method does not count. Handlers are called without a receiver. Duplicate action names in one call throw at `implement`.
- A plain handler or record is checked at `implement`; a builder's record when it is built. A record that slips past the types (plain JavaScript, a cast) throws `Unknown handlers` for a key no action names, and `Missing handlers` for an action without a function. From a builder, the layer build dies with the same message. Nothing is served with a handler missing.
- Builder lifetime and build-time versus request-time services: [guarantees.md](guarantees.md#dependency-lifetimes). The hook and authentication: [guarantees.md](guarantees.md#authorization). Surfaces keep the two kinds of services separate in their types, per action.
- A handler's input is typed from its action however it is written: an arrow, a function typed `Action.Handler`, or a generator, `Effect.fn(function* (input) { ... })` or `Effect.fnUntraced`, alone or in a record, a builder's included. The builder must itself be `implement`'s argument: through `.pipe(...)`, or a wrapper such as `Effect.withSpan(builder, name)`, an `Effect.fn` it returns takes an `any` input, so annotate the input there.
- Each handler already runs in a span named after its action, and every log line it writes is annotated with `action.name` and `action.access` ([guarantees.md](guarantees.md#observability)). Leave `Effect.fn` unnamed: don't wrap a handler in `Effect.fn(name)` or annotate its logs with the action's name yourself.
- `before` sees `action` typed as the implementation's own actions, in a built hook too. As for a builder, an `Effect.fn` hook returned through `.pipe(...)` or a wrapper takes an `any` action: annotate it, `(action: Action.Any)`.
- To pass a subset of an implementation's actions to a surface, such as dashboard-only writes kept off MCP, use `share([Write], users)`, which keeps `users`' hook, and pass each surface the ones it serves. The same handlers under another hook are `share(actions, users, trustAdmin)`, such as for a trusted admin CLI; public actions beside authenticated ones are `share([Poll], users, Action.allowAll)`. Leaving the hook out never drops authorization. The builder is the source's, which runs once per layer graph however many share it. A hook given to a share, built or not, is its own: its source's is neither built nor run for its actions.
- A shared implementation owes, per request, what its source's handlers owe for its actions, and what its hook owes: its source's, or the one given, whose services replace the source's. At startup it owes its source's services, its source's hook builder's included, and those of a hook it builds. `share` refuses an action its source does not implement: a type error, and `Not implemented by this implementation: <names>` from plain JavaScript.
- A helper over implementations is generic, `<const Apps extends Action.AnyImplementation | ReadonlyArray<Action.AnyImplementation>>(apps: Apps)`, so each implementation's requirements reach the surface it passes them to, `ActionHttp.layer` included, whose binding decides what it serves. Beside the helper's own implementations, spread the parameter, `[...apps, double]`: `ActionHttp.layer` and MCP refuse a type parameter listed as one element. `ActionHttp.layer` also refuses a binding or a share the helper makes from generic actions: take the binding as a type parameter, and pass the share in. `AnyImplementation` erases every channel to `unknown`: a value or a parameter typed with it owes `unknown`, which no surface can be given.
- `Implementation` is nominal. Spreading its properties does not produce an implementation. Surfaces match an implementation to an action by object identity, so implement the exact contract value a binding or a CLI selector receives.
- Test what an implementation does, its hook and its handlers, in process with `client`, each caller provided around its own calls ([Clients](#clients)); test what a surface adds, authentication, statuses and codecs, under `Testing.layer` ([Testing.md](Testing.md)). A builder's handlers exist only once it runs, so calling the function passed to `implement` works only for a plain handler, and skips the hook and every check. Cover each surface the application exposes.

### Clients

- `client(implementations)` takes one implementation or a list, as a surface does, and gives one method per action, named after it and taking its input directly: the methods `ActionHttp.client` gives, so moving between an in-process and a remote caller changes the line acquiring it. The argument may be left out when `{}` is a valid input, and is then what `{}` decodes to. Every implemented action has a method, whether or not a surface serves it. An action name twice among the implementations throws `Duplicate action: <name>` where `client` is called.
- A call runs as a remote one does, through the dispatch every surface shares. Its input passes through its JSON codec, encoded then decoded, so the handler receives what a remote handler decodes: an undeclared field dropped, as a client's encoding drops it, a class instance built anew, a decoding transformation such as a trim applied. The hook runs, then the handler, in its action's span, each call in a scope of its own ([guarantees.md](guarantees.md#dependency-lifetimes)). The success passes through its codec the same way, and a failure through the codec of every error the action declares, the built-in ones included, so the caller gets what a remote caller decodes: no undeclared field, a decoding transformation applied, `undefined` for a `Schema.Void` success. A failure keeps its trace: where the hook or the handler failed.
- A call fails with the action's declared errors and the built-in ones, as `ActionHttp.client` decodes them, and with nothing of a transport. Input that does not pass through its codec is `InvalidInput`, with the schema's message, and the hook and the handler never run; a class input is passed as an instance, as over HTTP. The hook's refusal, or an error every action of its implementation declares, is the call's failure. A success or a failure that does not pass, an error the action does not declare included, is a defect, its `SchemaError`, as it is an empty 500 over HTTP: the handler or the hook broke its contract.
- Each method owes, per call, what its handler and its implementation's hook read, the caller's identity included, and the caller provides it around the call, or around a program making several: `users.renameUser(input).pipe(Effect.provideService(CurrentActor, actor))`. A call reads its caller's context, never the one the client was acquired in: provided around the acquisition, a service reaches no call, so neither does a startup identity, and one client serves every caller.
- Acquiring a client builds its implementations' builders, and every hook an Effect builds, as a layer does: the acquisition owes their startup services and a `Scope`, and fails as they fail; no call does. Where it builds, and what it shares: [dependency lifetimes](guarantees.md#dependency-lifetimes). Acquire it where builders live, once: in a builder, in a layer providing it as a service of type `Action.Client<typeof users>`, or in a scoped program, such as a test, a job or a command. Never per request, in a handler.
- Under `share`, a client calls the share's actions alone, with its source's handlers, behind the share's hook: `client(share(actions, users, trustAdmin))` is a trusted program's own client.

## Failure modes

- `Invalid action name: <name>` thrown by `make`: the name is empty, longer than 128 characters, `then`, or has another character.
- `Invalid access: <value>` thrown by `make`: `access` is neither `"read"` nor `"write"`, which only a caller the compiler never sees can pass.
- `Expected 3 arguments, but got 2` (TS2554) at `implement`: the implementation states no hook. Pass its authorization hook, or `Action.allowAll` where every caller the surface admits may call.
- `Argument of type '... | undefined' is not assignable to parameter of type 'Hook<...>'` at `implement`: a hook that may be `undefined`, such as `enabled ? authorize : undefined`. Write `enabled ? authorize : Action.allowAll`.
- `Missing hook: pass an authorization hook, or Action.allowAll` thrown at `implement` or `share`, or the layer build dies with it: plain JavaScript passed no hook, or a value that is neither a hook nor an Effect building one, or that Effect built something else.
- Type error `Effect<..., X, ...> is not assignable` at `implement`: the handler fails with an undeclared error `X`. Add it to the action's `errors` or handle it.
- `Type 'X' is not assignable to type 'Refusal'` at `implement` or `share`, or to a union of `Refusal` and the errors every action declares (`'E | Refusal'`): the hook fails with `X`, and an action of the implementation does not declare it. The last line compares `X` with one of those members, as a `_tag` mismatch or as `Property '<field>' is missing in type 'X' but required in type 'E'`, a field of `E` rather than a missing handler. The message names what the hook may fail with, the refusals and the errors every action declares, not the action lacking `X`: add `X` to that action's `errors`, or implement the actions behind a hook without `X` and `share` those declaring it behind this one.
- `Property 'x' is missing in type` at `implement`: the record lacks a handler for action `x`.
- `Missing handlers: <names>` at `implement`, or when a builder's layer builds: the record has no own-property function for those actions. Add them to the record itself, not to a prototype.
- `Unknown handlers: <keys>` at `implement` or when a builder's layer builds, or a type error names a key: the record has a handler for an action not in this `implement` call. Remove it, or add its action to the list.
- `Duplicate action: <name>` at `implement`: the list names one action twice. Thrown by `client`: two of its implementations implement an action of that name, such as one and a `share` of it. Pass one.
- Handler receives a string where a number was expected: the schema is `Schema.String`, not a transforming codec such as `Schema.FiniteFromString`.
- `Property 'access' is missing` at `make`: every action declares `"read"` or `"write"`. There is no default.
- A service is resolved once and shared across requests when it should be per request: it was yielded in the builder, or in the Effect building the hook. Move the `yield*` into the handler, or the hook. An identity yielded there is a startup requirement of the layer; never provide one at startup.
- `HttpRouter.Request<"Requires", X>` still owed, or `Type 'X' is not assignable to type 'never'` at `runMain`, although `X`, a store the hook reads, is provided at startup: the hook yields it on every call. Yield it in an Effect that builds the hook ([Built hooks](#built-hooks)).
- `unknown` among a surface's requirements, and a type error where it is served or run, such as `Argument of type 'Layer<never, unknown, unknown>' is not assignable` at `HttpRouter.toWebHandler` or `Type 'unknown' is not assignable to type 'never'` where it is launched or run: the implementations are typed `Action.AnyImplementation`, as a helper's parameter or a list's annotation. Make the helper generic over them, or drop the annotation.
- `'readOnly' does not exist in type 'Hints'` at `make`, or `Type 'true' is not assignable to type 'never'` on `readOnly` beside another hint: a tool's read-only hint is its `access`. Set `access` instead.
- Type error on `hints.destructive` of a read action: a read is never destructive. Drop the hint, or make the action a write.
- `Type '...' is not assignable to type 'never'` on a key at `make`, in `hints` too: an option or hint it does not take, or a misspelled one.
- `Type 'H' is not assignable to type 'H & ...'` on `hints` at `make`, where `H` is a helper's type parameter, as in `<const H extends Action.Hints>(hints: H)`: the hint check cannot read hints a type parameter stands for, so it refuses them. An action's type carries no hint types, so type the parameter `Action.Hints`; the helper loses nothing.
- Type error on `errors` at `make`, `... is not assignable to type 'readonly never[]'` or naming the remaining errors: it lists a built-in error. Drop it; every surface declares it, and a handler may fail with it anyway.
- `Object literal may only specify known properties, and 'before' does not exist` at `implement`: the hook is the third argument itself, not an option of an object.
- `implement` throws `Duplicate error _tag in action "<name>": <tag>`: two of the action's errors, or members of a union among them, encode with one `_tag`, so a client could not tell them apart. Rename one.
- `implement` throws `Action "<name>": error _tag "Forbidden" is built in, and declared on every surface`: an error in the action's `errors`, or a member of a union there, encodes with the `_tag` of a built-in error, `InvalidInput`, `Unauthenticated` or `Forbidden`. Drop a built-in error from `errors`, since a handler may fail with it anyway; rename an error of your own.
- `Type 'CurrentActor' is not assignable to type 'never'` where a program calling a client runs: a call reads the caller, and nothing provides one around it. Provide it around the call, or around the calls it makes; provided around the acquisition, it reaches no call. Never provide it to a layer or a builder acquiring the client.
- A type error that a program still requires `Scope`: acquiring a client builds, as a layer does. Acquire it in a builder or a layer, or run the program in `Effect.scoped`.
- A builder runs on every request, or a route owes `HttpRouter.Request<"Requires", X>` for `X`, a service its builder yields: a handler acquires a client per request. Acquire it in the builder, and call it in the handler.
- A builder runs twice, or a job, an agent or a second server reads other state than the routes, such as an empty in-memory store: it is merged beside `HttpRouter.serve`, whose layer graph built the builder first. Put it inside the layer the server serves, or provide `Action.layer` and the services they share above both ([dependency lifetimes](guarantees.md#dependency-lifetimes)).
- Surfaces given startup services of their own, provided around each or to an `Action.layer` of each, all answer with one surface's: a builder runs once per layer graph, with the services of its first build. Wrap each surface in `Layer.fresh`, or give each an implementation of its own ([dependency lifetimes](guarantees.md#dependency-lifetimes)).
- `'<name>' implicitly has type 'any' because it does not have a type annotation and is referenced directly or indirectly in its own initializer` (TS7022) at `implement`, or, with the types bypassed, an acquisition that never completes: a builder acquires a client of its own implementation, directly or through another builder. Call the services both use instead.
- A call dies with a `SchemaError`: the handler's success, or what the handler or the hook fails with, does not pass through its codec, which an HTTP caller sees as an empty 500. Return what the success schema accepts, and fail with an error the action declares, as its schema accepts it.
- `InvalidInput` with `Expected <Class>` from a call given a plain object: the input is a class, which encodes only its instances. Pass `new Class({ ... })`, or leave out an argument whose fields are all optional.
- `Not an implementation made by this Action.implement: is effect-actions installed twice?` thrown by a surface, `client`, `share` or `layer`, or by a local CLI command when it runs: another installed copy of the package made the implementation, and only that copy serves, shares and calls it. Install one copy of the package; contracts and bindings still cross copies.
