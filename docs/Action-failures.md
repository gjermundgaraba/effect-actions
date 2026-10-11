# Action failure modes

What you see when something is wrong, and the fix. Search for a fragment of the message.
The tasks are in [Action.md](Action.md).

## At `make`

- `Invalid action name: <name>` thrown: the name is empty, longer than 128 characters, `then`, or has another character.
- `Property 'readOnly' is missing`, or `Invalid readOnly: <value>` thrown for a caller the compiler never sees: every action declares whether it is read-only. There is no default.
- `Property 'caller' is missing`, or `Missing caller: declare Action.Anyone or an identity service key` thrown: the contract does not state who may call it. Give `caller: Action.Anyone` or an identity service.
- `Type ... is not assignable to type '"An identity is a Context.Service, not a Context.Reference"'`, or `Invalid caller: an identity is a Context.Service, not a Context.Reference` thrown: `caller` is a `Context.Reference`. Declare the identity with `Context.Service`.
- `'readOnlyHint' does not exist in type 'Mcp'`, or `Type 'true' is not assignable to type 'never'` on `readOnlyHint` beside another hint: a tool's read-only hint is its action's `readOnly`. Set `readOnly` instead.
- `'<key>' does not exist in type 'Options'`, or `in type 'Mcp'`, or `Type '...' is not assignable to type 'never'` on the key: an option or hint `make` does not take, or a misspelled one, such as `destructive` for `destructiveHint`.
- `Type 'H' is not assignable to type 'H & ...'`, where `H` is a helper's type parameter, as in `<const H extends Action.Mcp>(mcp: H)`: `make` refuses options a type parameter stands for. Type the parameter `Action.Mcp`; an action's type carries no `mcp` types. A constant object spread into the options is read as written.
- A type error on `error`, `... is not assignable to type 'readonly never[]'` or naming the remaining errors: it lists a built-in error. Drop it; a handler may fail with it anyway.
- `Action "<name>": error _tag "Forbidden" is built in, and declared on every surface` thrown: an entry of `error`, or a member of a union there, encodes with the `_tag` `InvalidInput`, `Unauthenticated` or `Forbidden`. Drop a built-in error; rename an error of your own.
- `ReferenceError` thrown: an entry of `error` is a `Schema.suspend` whose thunk reads a `const` declared further down. `make` reads every error's `_tag` when it is called; declare the error first.

## At `implement`

- `... is not assignable to parameter of type 'ProtectedActionsTakeAuthorize'`, ending `Type 'typeof CurrentUser' is not assignable to type 'unique symbol'`: the target holds a protected action and states no `authorize`. Pass `{ authorize }`, or `{ authorize: Action.allowAll }`. Plain JavaScript throws `Protected actions require authorize, or Action.allowAll`.
- `No overload matches this call`, ending `... is not assignable to type '"A public-only target takes no authorize"'`, or that message thrown from plain JavaScript: an implementation of public actions alone states `authorize`, which nothing would run. Drop it, or make the contract protected.
- `Missing authorize: pass an authorization function, or Action.allowAll` thrown, or the layer build dies with it: `authorize` is neither a function nor an Effect building one, or that Effect built something else.
- `No overload matches this call`, ending `Type 'undefined' is not assignable to type 'Authorizer<...>'`: an authorizer that may be `undefined`. Write `enabled ? authorize : Action.allowAll`.
- `Parameter 'action' implicitly has an 'any' type`, or an `Effect.fn` authorizer whose `action` is `any`, where it is defined apart from `implement`: annotate it, `(action: Action.Any)`.
- `Type 'X' is not assignable to type 'Forbidden | Unauthenticated'`, ending `Property '"~declared in the action's error, or built in"' is missing in type 'X'`: the authorizer fails with `X`, which is not a refusal. A limit or another failure callers should see is the handler's: declare `X` in the action's `error` and fail with it there.
- `No overload matches this call`, ending `Property '"~declared in the action's error, or built in"' is missing in type 'X'`, under `Type 'X' is not assignable to type 'Forbidden | InvalidInput | Unauthenticated'` or a longer union: the handler fails with an undeclared error `X`. Add it to the action's `error`, or handle it.
- `Property 'x' is missing in type`, or `Missing handlers: <names>` thrown, also when a builder's layer builds: the record has no own-property function for those actions. Add them to the record itself, not to a prototype.
- `Unknown handlers: <keys>` thrown, also when a builder's layer builds, or a type error naming a key: the record has a handler for an action not in this `implement` call. Remove it, or add its action to the list.
- `Duplicate action: <name>` thrown, by `byName` too: the list names one action twice.
- `'<name>' implicitly has type 'any' because it does not have a type annotation and is referenced directly or indirectly in its own initializer` (TS7022), or, with the types bypassed, an acquisition that never completes: a builder acquires a client of its own implementation, directly or through another builder. Call the services both use instead.
- A handler receives a string where a number was expected: the schema is `Schema.String`, not a transforming codec such as `Schema.FiniteFromString`.

## Where an implementation is served

- `Type 'CurrentUser' is not assignable to type 'never'`, or `Request<"Requires", CurrentUser>` still owed, for a layer serving only public actions: a public action's handler reads the identity, which no surface provides to a public action. Make the action protected.
- `Type '"A builder yields the caller, which a server has per request: yield it in a handler or an authorizer"' is not assignable to type 'never'` where a server is launched, or that sentence among a test's requirements at `it.effect`: a builder, or the Effect building the authorizer, yields the caller's identity, which `ActionHttp.layer`, `ActionRpc.layer` and `ActionMcp.layerHttp` have per request alone. Move the `yield*` into the handler or the authorizer.
- A service is resolved once and shared across requests when it should be per request: it was yielded in the builder, or in the Effect building the authorizer. Move the `yield*` into the handler or the authorizer.
- `HttpRouter.Request<"Requires", X>` still owed, or `Type 'X' is not assignable to type 'never'` at `runMain`, although `X`, a store the authorizer reads, is provided at startup: the authorizer yields it on every call. Yield it in an Effect that builds the authorizer ([Authorize calls](Action.md#authorize-calls)).
- `unknown` among a surface's requirements, and a type error where it is served or run, such as `Argument of type 'Layer<never, unknown, unknown>' is not assignable` at `HttpRouter.toWebHandler` or `Type 'unknown' is not assignable to type 'never'`: the implementations are typed `Action.AnyImplementation`, as a helper's parameter or a list's annotation. Make the helper generic over them, `<const Apps extends Action.AnyImplementation | ReadonlyArray<Action.AnyImplementation>>(apps: Apps)`, or drop the annotation.
- `Request<"Requires", unknown>` where an implementation is served, or `unknown` among the services a call or a run still requires: TypeScript inferred no requirements for a handler of a record. A data-first call whose type takes a parameter from no argument does it, `Effect.catchTag(effect, tag, f)` for one. Write that handler's Effect `effect.pipe(Effect.catchTag(tag, f))`, or as a generator.
- A builder runs twice, or a job, an agent or a second server reads other state than the routes, such as an empty in-memory store: it is merged beside `HttpRouter.serve`, whose layer graph builds on its own. Put it inside the layer the server serves, or provide `Action.layer` and the services they share above both ([Share one build across servers](Action-in-process.md#share-one-build-across-servers)).
- Two surfaces in one layer graph, each given startup services of its own, both answer with one surface's: a builder runs once per layer graph, with the services of its first build. Provide the services once; where the surfaces must differ, wrap each in `Layer.fresh`, providing what they share, authentication included, outside it, or give each an implementation of its own.
- `Not an implementation made by this Action.implement: is effect-actions installed twice?` thrown by a surface, `client` or `layer`, or by a local CLI command when it runs: another installed copy of the package made the implementation, or the value is a copy of one, such as a spread. Install one copy of the package, since contracts and bindings cross copies but implementations do not, and pass the value `implement` returned.

## At `client` and its calls

- `Listed in actions, but no implementation holds it: <names>` thrown: a listed action is none of the implementations'. Pass the implementation holding it, or check that the contract values are the ones it implemented.
- `Duplicate action: <name>` thrown: two of the implementations implement an action of that name. Two contracts sharing a name are told apart by `actions`, listing one; two implementations of one contract are not: pass one.
- `Type 'CurrentUser' is not assignable to type 'never'` where a program calling a client runs: a protected action's call owes the caller, and nothing provides one around it. Provide it around the call; provided around the acquisition, it reaches no call.
- A type error that a program still requires `Scope`: acquiring a client builds, as a layer does. Acquire it in a builder or a layer, or run the program in `Effect.scoped`.
- A builder runs on every request, or a route owes `HttpRouter.Request<"Requires", X>` for `X`, a service its builder yields: a handler acquires a client per request. Acquire it in the builder, and call it in the handler.
- A call dies with a `SchemaError`: the handler's success, or what it fails with, does not pass through its codec. A failure follows the `SchemaError` in the cause, as `Cause.pretty` shows. Return what the success schema accepts, and fail with an error the action declares.
- `InvalidInput` with `Expected <Class>` from a call given a plain object: the input is a class, which encodes only its instances. Pass `new Class({ ... })`.
