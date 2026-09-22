# ActionGroup

A named set of actions. The group is what adapters serve, what clients are grouped by, and
what `implement` binds handlers to. Shared errors and the HTTP schema-error policy live here.
The pre-handler hook does not: each surface binds its own (see [guarantees.md](guarantees.md)).

## API

Import `@gjermundgaraba/effect-actions/ActionGroup`.

| API                               | Purpose                                                                                 |
| --------------------------------- | --------------------------------------------------------------------------------------- |
| `make(options, ...actions)`       | Group actions under a required `name`; optional `errors` are inherited by each action.  |
| `group.implement(recordOrEffect)` | Bind every action handler; an Effect builder carries startup requirements and failures. |
| `app.group`, `app.build`          | Bound contract and scoped handler acquisition.                                          |
| `contracts(...groups)`            | Exact action types keyed by `<group>.<action>`.                                         |

Exported types: `Group`, `Any`, `Options`, `Implementation`, `Contracts`, `SchemaErrorPolicy`,
`SchemaErrorAnswer`.

The optional `schemaError` group option is a `SchemaErrorPolicy`: two answers, `invalid` and
`internal`, each a `schema` (a declared error codec) and `make(failure)` (the native
`HttpApiSchemaError` to that error's decoded value). The library decides which answer applies.
It affects HTTP only. Handler records require every action key. Each handler's input, success
and declared errors come from its action; request requirements stay distinct from the
builder's requirements.

## Canonical

```ts
import { Effect, Schema } from "effect";
import * as ActionGroup from "@gjermundgaraba/effect-actions/ActionGroup";
import { CurrentActor } from "./auth.js";
import { GetUser, RenameUser, WhoAmI } from "./contracts.js";
import { Users } from "./users.js";

class InvalidRequest extends Schema.TaggedError<InvalidRequest>()(
  "InvalidRequest",
  { message: Schema.String },
  { httpApiStatus: 400 },
) {}
class InternalError extends Schema.TaggedError<InternalError>()(
  "InternalError",
  { message: Schema.String },
  { httpApiStatus: 500 },
) {}

// A request that does not decode is the caller's fault; a result that does not
// encode is the server's. Shared across groups as a constant.
const schemaError = {
  invalid: {
    schema: InvalidRequest,
    make: () => new InvalidRequest({ message: "The request does not match the action's input." }),
  },
  internal: {
    schema: InternalError,
    make: () => new InternalError({ message: "The request could not be completed." }),
  },
};

export const UserActions = ActionGroup.make(
  { name: "users", schemaError },
  GetUser,
  RenameUser,
  WhoAmI,
);

// Build-time services (Users) are yielded in the builder, once per adapter layer.
// Request-time services (CurrentActor) are yielded inside handlers. Authorization
// is not here: each adapter binds one `before` hook for every group it serves.
export const UserApp = UserActions.implement(
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

// No build-time services: pass the record directly.
export const MathApp = MathActions.implement({ double: ({ value }) => Effect.succeed(value * 2) });

// One typed map of every contract, keyed "<group>.<action>".
export const contracts = ActionGroup.contracts(UserActions, MathActions);
const renames: "renameUser" = contracts["users.renameUser"].name;
```

## Rules

- `name` matches `[A-Za-z0-9_-]+`, cannot be `then`, and must be unique within one `ActionHttp.make`. Action names must be unique within the group. MCP tool names must be unique within the group and within each Toolkit or MCP projection that serves it. Duplicates fail at `make`.
- Group `errors` are appended to each action's own `errors`, so every handler of the group may fail with them. A failure that only the surface produces belongs on the adapter instead (`ActionHttp.make`'s `errors`, `ActionMcp`'s and `ActionToolkit`'s `errors`), not here.
- `implement` takes a complete record or an Effect producing one. Every action must have a handler; missing keys are compile errors. A record that still lacks one at runtime (plain JavaScript, a cast) throws at `implement`; a builder's record fails the adapter layer's build. Nothing is served with a handler missing. Additional keys are not dispatched. It takes nothing else.
- The builder Effect runs once per adapter layer that serves the implementation, in that layer's scope. An implementation served by HTTP and MCP is built twice. Acquire shared state in a Layer you provide to the adapters, not in the builder.
- Services yielded in the builder are build-time requirements (`RX`). Services yielded in a handler are request-time requirements (`R` of the handler). Adapters keep these separate in their types. Use distinct tags for each kind; never provide a request-identity tag at startup (see [guarantees.md](guarantees.md)).
- `Implementation` is nominal. Spreading its properties does not produce an implementation. Each `implement` call is a separate binding.
- `build` exists for direct handler tests under `Effect.scoped`. It bypasses transport validation and the hook, and is not a substitute for adapter tests. There is no public handler service or Layer.
- `contracts(...groups)` returns one record keyed `<group>.<action>`, with each action's exact contract type. Duplicate group names throw. Use it where routes, tools, jobs or commands must name an action: the key set is derived, so an added action cannot be missed.

### Schema-error policy

- Without a policy, HTTP answers decoding and encoding failures with Effect's native empty 400.
- With a policy, the library picks the answer from the native `HttpApiSchemaError`'s `kind`. Request-side kinds (`Payload`, `Params`, `Headers`, `Query`: the request did not decode) get `invalid`; response-side kinds (`Body`, `ResponseHeaders`: the handler's result did not encode) get `internal`. `make` receives the failure (`kind`, `cause`) and returns its schema's value. HTTP uses that error's `httpApiStatus`, and both errors appear in `Http.api`, in clients, and in OpenAPI.
- In practice only `Payload` and `Body` occur: actions declare no parameters, query, or headers, and no response headers.
- `invalid` and `internal` may share one schema; it is declared once.
- MCP is unaffected. The native `McpServer` answers invalid arguments and unencodable results itself.
- Policy errors extend the transport contract, not the handler contract. A handler cannot return them.
- The policy runs only on the server. Client-side codec failures stay `SchemaError`.
- HTTP decodes with `errors: "all"`, so `cause` carries every issue. Issues never retain the rejected values.
- Groups served by one adapter may have different policies; each action answers with its own group's.
- Input schema-error policies run before the `before` hook. Invalid input is answered by the policy without invoking the hook or handler.
- Domain errors, defects, interruptions, and protocol errors are not remapped. An unencodable declared error is a defect. A broken policy error is not recursively remapped.

## Failure modes

- Throws at `make`: duplicate action name, duplicate MCP tool name, invalid group name.
- `Property 'x' is missing in type` at `implement`: the record lacks a handler for action `x`.
- Handler compiles but returns an error not in `errors`: type error on the handler's error channel. Declare it on the action or the group.
- `Expected 1 arguments, but got 2` at `implement`: the second options object is gone. Move `before` to the adapter that serves the group.
- `Parameter 'failure' implicitly has an 'any' type` in a standalone policy constant: a `make` that reads the failure is typed only inline. Annotate the parameter as `HttpApiError.HttpApiSchemaError` (type import from `effect/unstable/httpapi`), or annotate the constant as `ActionGroup.SchemaErrorPolicy<typeof Invalid, typeof Internal>`.
- `Missing handlers for group "<group>": <actions>` thrown at `implement`, or failing the layer build: the handler record lacks those actions. Add them.
- A service is resolved once and shared across requests when it should be per request: it was yielded in the builder. Move the `yield*` into the handler.
- `Duplicate contract group` thrown by `contracts`: two groups share a name, so their keys would collide. Rename one.
