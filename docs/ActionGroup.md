# ActionGroup

A named set of actions. The group is what adapters serve, what clients are grouped by, and
what `implement` binds handlers to. Shared errors and the HTTP schema-error policy live here.

## API

```ts
import * as ActionGroup from "@gjermundgaraba/effect-actions/ActionGroup";

function make<Name, Actions, Errors = [], PolicyErrors = []>(
  options: Options<Name, Errors, PolicyErrors>,
  ...actions: Actions
): Group<Name, WithErrors<Actions, Errors>, PolicyErrors>;

interface Options<Name, Errors, PolicyErrors> {
  readonly name: Name; // HttpApiGroup identifier, OpenAPI tag, operation-ID prefix
  readonly errors?: Errors; // added to every action's own errors
  readonly schemaError?: SchemaErrorPolicy<PolicyErrors>; // HTTP only; MCP keeps native answers
}

interface SchemaErrorPolicy<Errors extends ReadonlyArray<Codec>> {
  readonly errors: Errors;
  readonly map: (failure: HttpApiError.HttpApiSchemaError) => Errors[number]["Type"];
}

interface Group<Name, Actions, PolicyErrors> {
  readonly name: Name;
  readonly actions: Actions;
  readonly schemaError: SchemaErrorPolicy<PolicyErrors> | undefined;
  /** Bind every handler at once; build-time services resolve once per adapter layer. */
  readonly implement: <H extends HandlersFrom<Actions>, EX = never, RX = never>(
    build: H | Effect.Effect<H, EX, RX>,
  ) => Implementation<Group<Name, Actions, PolicyErrors>, H, EX, Exclude<RX, Scope.Scope>>;
}

/** Nominal. `group` is the bound contract; `build` acquires the handler record in a scope. */
class Implementation<G, H, EX, RX> {
  readonly group: G;
  get build(): Effect.Effect<H, EX, RX | Scope.Scope>;
}
```

`HandlersFrom<Actions>` is `{ [action name]: Handler<Action, R> }`, one key per action,
all required.

## Canonical

```ts
import { Effect, Schema } from "effect";
import type { HttpApiError } from "effect/unstable/httpapi";
import * as ActionGroup from "@gjermundgaraba/effect-actions/ActionGroup";
import { Forbidden, authorize, CurrentActor } from "./auth.js";
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

// Shared across groups: annotate the parameter. Inline, `map` is inferred from `errors`.
const schemaError = {
  errors: [InvalidRequest, InternalError],
  map: ({ kind }: HttpApiError.HttpApiSchemaError) =>
    kind === "Body" || kind === "ResponseHeaders"
      ? new InternalError({ message: "The request could not be completed." })
      : new InvalidRequest({ message: "The request does not match the action's input." }),
};

// `Forbidden` is declared once and joins every action's errors.
export const UserActions = ActionGroup.make(
  { name: "users", errors: [Forbidden], schemaError },
  GetUser,
  RenameUser,
  WhoAmI,
);

// Build-time services (Users) are yielded in the builder, once per adapter layer.
// Request-time services (CurrentActor) are yielded inside handlers.
export const UserApp = UserActions.implement(
  Effect.gen(function* () {
    const users = yield* Users;

    return {
      getUser: ({ id }) =>
        Effect.gen(function* () {
          const actor = yield* authorize("users:read");

          return yield* users.get(actor.tenantId, id);
        }),
      renameUser: ({ id, name }) =>
        Effect.gen(function* () {
          const actor = yield* authorize("users:write");

          return yield* users.rename(actor, id, name);
        }),
      whoAmI: () => Effect.map(CurrentActor, ({ id, tenantId }) => ({ id, tenantId })),
    };
  }),
);

// No build-time services: pass the record directly.
export const MathApp = MathActions.implement({ double: ({ value }) => Effect.succeed(value * 2) });
```

## Rules

- `name` matches `[A-Za-z0-9_-]+` and must be unique within one `ActionHttp.make`. Action names must be unique within the group. MCP tool names must be unique within the group and within each Toolkit or MCP projection that serves it. Duplicates fail at `make`.
- Group `errors` are appended to each action's own `errors`, so every handler of the group may fail with them.
- `implement` takes a complete record or an Effect producing one. The record must have exactly one handler per action; a missing key is a compile error.
- The builder Effect runs once per adapter layer that serves the implementation, in that layer's scope. An implementation served by HTTP and MCP is built twice. Acquire shared state in a Layer you provide to the adapters, not in the builder.
- Services yielded in the builder are build-time requirements (`RX`). Services yielded in a handler are request-time requirements (`R` of the handler). Adapters keep these separate in their types. Use distinct tags for each kind; never provide a request-identity tag at startup (see [guarantees.md](guarantees.md)).
- `Implementation` is nominal. Spreading its properties does not produce an implementation. Each `implement` call is a separate binding.
- `build` exists for direct handler tests under `Effect.scoped`. It bypasses transport validation and is not a substitute for adapter tests. There is no public handler service or Layer.

### Schema-error policy

- Without a policy, HTTP answers decoding and encoding failures with Effect's native empty 400.
- With a policy, `map` receives the native `HttpApiSchemaError` (`kind`, `cause`) and returns one of `errors`. HTTP uses that error's `httpApiStatus`, and the error appears in `Http.api`, in clients, and in OpenAPI.
- `kind` values: `Payload` (input decoding) and `Body` (success encoding). Actions declare no parameters, query, or headers, so no other kind occurs.
- MCP is unaffected. The native `McpServer` answers invalid arguments and unencodable results itself.
- Policy errors extend the transport contract, not the handler contract. A handler cannot return them.
- The policy runs only on the server. Client-side codec failures stay `SchemaError`.
- HTTP decodes with `errors: "all"`, so `cause` carries every issue. Issues never retain the rejected values.
- Groups served by one adapter may have different policies; each action answers with its own group's.
- Domain errors, defects, interruptions, and protocol errors are not remapped. An unencodable declared error is a defect. A broken policy error is not recursively remapped.

## Failure modes

- Throws at `make`: duplicate action name, duplicate MCP tool name, invalid group name.
- `Property 'x' is missing in type` at `implement`: the record lacks a handler for action `x`.
- Handler compiles but returns an error not in `errors`: type error on the handler's error channel. Declare it on the action or the group.
- `map` is not typed from `errors` when declared as a standalone constant: annotate its parameter as `HttpApiError.HttpApiSchemaError` (type import from `effect/unstable/httpapi`).
- A service is resolved once and shared across requests when it should be per request: it was yielded in the builder. Move the `yield*` into the handler.
