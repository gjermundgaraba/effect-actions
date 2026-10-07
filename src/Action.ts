import { Array as Arr, Cause, Context, Effect, type Layer, Predicate, Schema } from "effect";
import type { Scope } from "effect";
import {
  Anyone,
  assertOwnTags,
  assertKnown,
  assertName,
  assertOnce,
  errorList,
  projectedErrors,
} from "./internal/actions.js";
import { type Call, inputOf } from "./internal/call.js";
import { type BuiltIn, type BuiltIns, InvalidInput, type Refusal } from "./internal/errors.js";
import {
  type ActionOf,
  type Authorize,
  type Bound,
  type BuildServices,
  type BuildError,
  builders,
  built,
  type ErasedAuthorize,
  type ErasedHandler,
  type ErasedValue,
  type Handlers as ErasedHandlers,
  Implementation,
  type Member,
  memoized,
  type RequestOf,
  type Protected,
  type Holding,
  type Known,
  type Offered,
  type OptionalUnless,
  type SelectedOf,
  type Serving,
  select,
  type Served,
  toList,
} from "./internal/implementation.js";

/**
 * What a surface serving the actions `Listed` of the implementations `App` reads at startup:
 * their builders' and built authorizers' services.
 */
export type { BuildServices } from "./internal/implementation.js";

/**
 * What a surface serving the actions `Listed` of the implementations `App` fails with at
 * startup: their builders' and built authorizers' failures.
 */
export type { BuildError } from "./internal/implementation.js";

/** An action bound to its handler; opaque, see `implement`. */
export type { Implementation } from "./internal/implementation.js";

/** Authorization for protected contracts: it refuses, and fails with nothing else. */
export type { Authorize } from "./internal/implementation.js";

/**
 * Any implementation, with its actions and channels erased: the constraint of a helper
 * generic over implementations, `<App extends Action.AnyImplementation>`, whatever surface it
 * passes them to; `AnyImplementation<A>` is one of the actions `A`. A value of this type owes
 * `unknown`, which no surface can be given.
 */
export type { AnyImplementation } from "./internal/implementation.js";

/** Any service-free schema. Only handlers may require services. */
type Codec = Schema.Codec<unknown, unknown, never, never>;

/** Struct fields, accepted wherever a struct schema is: `{ name: Schema.String }`. */
type Fields = { readonly [key: string]: Codec };

/**
 * An object without fields: an action without arguments, `{}` given or not. Effect's own
 * `Tool.EmptyParams`: strict, unlike `Schema.Struct({})`, which accepts any value but `null`,
 * and the object root MCP requires.
 */
const NoInput = Schema.Record(Schema.String, Schema.Never);

/** The schema a `Codec | Fields` option stands for: a schema itself, `NoInput` for no fields. */
type CodecOf<S extends Codec | Fields> = S extends Codec
  ? S
  : S extends Schema.Struct.Fields
    ? keyof S extends never
      ? typeof NoInput
      : Extract<Schema.Struct<S>, Codec>
    : never;

/**
 * The caller of a public action, `caller: Action.Anyone`: anyone, signed in or not, and no
 * authorizer runs for it.
 */
export { Anyone } from "./internal/actions.js";

/**
 * How the action's tool presents itself over MCP, in MCP's own names; every field is optional
 * and none enforces anything. A hint left out is MCP's default, but `destructiveHint`, which is
 * `false` for a read-only action. `readOnlyHint` is not one: it is always the contract's
 * `readOnly`, so a tool cannot say otherwise than its contract.
 */
export interface Mcp {
  /** The tool's display name, `annotations.title`, beside its name. */
  readonly title?: string | undefined;
  /** `annotations.destructiveHint`, meaningful for a write only. */
  readonly destructiveHint?: boolean | undefined;
  /** `annotations.idempotentHint`, meaningful for a write only. */
  readonly idempotentHint?: boolean | undefined;
  /** `annotations.openWorldHint`: whether the tool reaches entities outside its own domain. */
  readonly openWorldHint?: boolean | undefined;
  /** The tool's `_meta`, JSON such as an MCP App's UI resource, sent as given. */
  readonly _meta?: { readonly [key: string]: Schema.Json } | undefined;
}

/**
 * The failures every surface declares and any handler may fail with, and the refusals among
 * them; see `internal/errors`.
 */
export {
  type BuiltIn,
  Forbidden,
  InvalidInput,
  type Refusal,
  Unauthenticated,
} from "./internal/errors.js";

/** What `make` needs to define an action. */
export interface Options {
  /**
   * Who may call the action: `Action.Anyone`, or the identity service a caller must have,
   * which every surface enforces. Required: an action that names no caller is not public.
   */
  readonly caller: typeof Anyone | Context.Key<unknown, unknown>;
  readonly description: string;
  /** A schema or struct fields. Omit, or give `{}`, for an action without arguments. */
  readonly input?: Codec | Fields | undefined;
  /** A schema or struct fields. Omit for an action that returns nothing: `Schema.Void`. */
  readonly success?: Codec | Fields | undefined;
  /**
   * The declared failures: one schema, or a list of them, as `HttpApiEndpoint` takes them;
   * each keeps its own HTTP status annotation. Defaults to none. None with a built-in
   * error's `_tag`.
   */
  readonly error?: Codec | ReadonlyArray<Codec> | undefined;
  /**
   * Whether the action leaves its resource unchanged. Required: an action nobody classified
   * is the one a reviewer must check. An implementation's `authorize` may read it, and MCP's
   * `readOnlyHint` is it; the library itself authorizes nothing with it.
   */
  readonly readOnly: boolean;
  /** How the action's tool presents itself over MCP, and on a native Toolkit's tools. */
  readonly mcp?: Mcp;
}

/**
 * The keys beyond `Mcp` in the `mcp` of any member of `O`, given or optional, so a misspelled
 * one in a conditional spread or in one branch of a ternary is refused too.
 */
type UnknownMcp<O> = O extends { readonly mcp?: infer H }
  ? Exclude<H extends unknown ? keyof H : never, keyof Mcp>
  : never;

/** No key beyond `Mcp`, whichever member of `O` gives it. */
type KnownMcp<O> = { readonly mcp?: { readonly [K in UnknownMcp<O>]: never } };

/** The schemas an `error` option of type `G` declares: one, or each of a list. */
type ErrorMembers<G> = G extends ReadonlyArray<infer E> ? E : G;

/**
 * The built-in errors, refused in `error`: every surface declares them already. The types
 * refuse only the built-ins themselves; `make` refuses, when called, an error of your own
 * that encodes with a built-in `_tag`.
 */
type OwnErrors<O> = O extends { readonly error: infer G }
  ? [Extract<ErrorMembers<G>, BuiltIns>] extends [never]
    ? unknown
    : {
        readonly error:
          | Exclude<ErrorMembers<G>, BuiltIns>
          | ReadonlyArray<Exclude<ErrorMembers<G>, BuiltIns>>;
      }
  : unknown;

/**
 * No option beyond `Options` in any member of `O`, so a misspelled one is an unknown
 * property, not ignored: `keyof` a union holds only the keys every member has.
 */
type OnlyOptions<O> = {
  readonly [K in Exclude<O extends unknown ? keyof O : never, keyof Options>]: never;
};

/**
 * `caller` is a `Context.Service`: a `Context.Reference` is never missing, so its default
 * would stand in for every caller who supplies none.
 */
type ServiceCaller<O> = O extends { readonly caller: { readonly defaultValue: unknown } }
  ? { readonly caller: "An identity is a Context.Service, not a Context.Reference" }
  : unknown;

/**
 * The rules `make` checks beyond `Options`: every option and `mcp` key known, and no built-in
 * error listed. Options that fail `Options` itself infer as `Options`, whose error the
 * compiler already reports, so they are not checked again. Checked after inference: `make`'s
 * options are `O & NoInfer<Rules<O>>`.
 */
type Rules<O> = Options extends O
  ? unknown
  : OnlyOptions<O> & ServiceCaller<O> & OwnErrors<O> & KnownMcp<O>;

/**
 * Option `K` of `O` as given, or also `Default` wherever it may be omitted or undefined, as
 * at run time, for each member of a union of options.
 */
type OptionOf<O, K extends keyof Options, Default> = O extends unknown
  ? K extends keyof O
    ?
        | Exclude<O[K], undefined>
        | ({} extends Pick<O, K> ? Default : undefined extends O[K] ? Default : never)
    : Default
  : never;

/** The schema option `K` of `O`, or `Default` when it is omitted. */
type SchemaOf<O, K extends "input" | "success", Default extends Codec> = CodecOf<
  Extract<OptionOf<O, K, Default>, Codec | Fields>
>;

/** The declared errors of `O`, none when omitted. */
type ErrorsOf<O> = ReadonlyArray<
  ErrorMembers<Extract<OptionOf<O, "error", []>, Codec | ReadonlyArray<Codec>>>
>;

/** A pure contract: schemas and transport metadata. Handlers are bound by `implement`. */
export interface Action<
  Name extends string,
  Input extends Codec,
  Success extends Codec,
  Errors extends ReadonlyArray<Codec>,
  ReadOnly extends boolean = boolean,
  Caller extends Options["caller"] = Options["caller"],
> {
  readonly caller: Caller;
  readonly name: Name;
  readonly description: string;
  readonly input: Input;
  readonly success: Success;
  /** The declared failures, as a list: one given alone is a list of one. */
  readonly error: Errors;
  // Declared, never defaulted, so a type selecting the reads, such as
  // `Extract<A, { readOnly: true }>`, reads a literal.
  readonly readOnly: ReadOnly;
  /** The `mcp` options as given, none when left out. */
  readonly mcp: Mcp;
}

/** Any action, with its schemas erased. */
export type Any = Action<string, Codec, Codec, ReadonlyArray<Codec>>;

/** Receives decoded input; may fail only with the declared errors and the built-in ones. */
export type Handler<A extends Any, R = never> = (
  input: A["input"]["Type"],
) => Effect.Effect<A["success"]["Type"], A["error"][number]["Type"] | BuiltIn, R>;

/**
 * The handlers of the actions `A`, keyed by name, as `implement` takes them: what a builder
 * written apart from `implement` returns, `satisfies Action.Handlers<typeof actions>`, so its
 * handlers are typed from their contracts, as another authorizer of the same handlers needs.
 */
export type Handlers<A extends ReadonlyArray<Any>, R = never> = {
  readonly [Action in A[number] as Action["name"]]: Handler<Action, R>;
};

/**
 * The schema an option stands for: a schema as given, `NoInput` for no fields, or the struct
 * of the fields, which may be keyed by symbols, as in a struct.
 */
const codecOf = (schema: Codec | Fields): Codec =>
  Schema.isSchema(schema)
    ? schema
    : Reflect.ownKeys(schema).length === 0
      ? NoInput
      : Schema.Struct(schema);

/**
 * Define an action contract. Names are `[A-Za-z0-9_-]{1,128}`, other than `then`: the name
 * is also the route segment, the client method and the tool name.
 */
export function make<const Name extends string, const O extends Options>(
  name: Name,
  options: O & NoInfer<Rules<O>>,
): Action<
  Name,
  SchemaOf<O, "input", typeof NoInput>,
  SchemaOf<O, "success", typeof Schema.Void>,
  ErrorsOf<O>,
  O["readOnly"],
  O["caller"]
>;
export function make(name: string, options: Options): Any {
  assertName("action name", name);

  const { caller, readOnly } = options;

  if (caller !== Anyone && !Context.isKey(caller)) {
    throw new Error("Missing caller: declare Action.Anyone or an identity service key");
  }

  // A reference's default is always present, so it would authenticate every caller.
  if (caller !== Anyone && Context.isReference(caller)) {
    throw new Error("Invalid caller: an identity is a Context.Service, not a Context.Reference");
  }

  // The type is the only thing stopping another value, and a plain-JavaScript
  // caller has none: an unclassified action must not reach an authorizer that reads it.
  if (readOnly !== true && readOnly !== false) {
    throw new Error(`Invalid readOnly: ${String(readOnly)}`);
  }

  const action: Any = {
    caller,
    name,
    description: options.description,
    input: codecOf(options.input ?? {}),
    success: options.success === undefined ? Schema.Void : codecOf(options.success),
    error: errorList(options.error),
    readOnly,
    mcp: { ...options.mcp },
  };

  assertOwnTags(`Action "${action.name}"`, action.error);

  return action;
}

/**
 * `actions` keyed by name, each its exact contract: `byName(actions).getUser`, its schemas
 * where a test or a mock reads them, and its types where a helper takes a name,
 * `(typeof contracts)[K]["input"]["Type"]`, which resolves under a generic `K` where
 * `Extract` over the list does not. The list is typed by its members, as every surface types
 * one. A name held twice is refused, as a surface refuses it.
 */
export function byName<const Actions extends ReadonlyArray<Any>>(
  actions: Actions,
): { readonly [A in Actions[number] as A["name"]]: A };
export function byName(actions: ReadonlyArray<Any>): { readonly [name: string]: Any } {
  assertOnce("action", actions);

  return Object.fromEntries(actions.map((action) => [action.name, action]));
}

/** What `implement` binds: one action, or several that share one builder. */
type Target = Any | ReadonlyArray<Any>;

/**
 * A target of public actions only, which takes no `authorize`. Named for what a protected
 * target lacks there, as the error a call without `authorize` reports names this type.
 */
type ProtectedActionsTakeAuthorize = PublicAction | ReadonlyArray<PublicAction>;

/** An action anyone may call. */
type PublicAction = Any & { readonly caller: typeof Anyone };

/**
 * The actions `T` stands for. One action is extracted rather than taken as it is, so where `T`
 * is deferred, such as a list of a helper's type parameter, the actions are still actions to
 * TypeScript, and a selection of them reaches a surface.
 */
type ActionsOf<T extends Target> = T extends ReadonlyArray<Any> ? T[number] : Extract<T, Any>;

/** The names of the actions `T` stands for. */
type NamesOf<T extends Target> = ActionsOf<T>["name"];

/**
 * What a name `K` owes per request for the authorizer, `RA`, besides its handler's: nothing, as the
 * authorizer's requirements have a key of their own, unless `K` is `string`. Names typed only as
 * `string`, such as an `Action.Any`'s, absorb that key, so each owes the authorizer's too.
 */
type AuthorizerOwed<K, RA> = string extends K ? RA : never;

/**
 * What a list takes instead of one handler: nothing. A named alias carrying `R`, and it must
 * stay one: while a builder's inner call, such as `Effect.gen`, is inferred, TypeScript keeps
 * an alias's arguments marked as not yet inferred, where `never` or this type written inline
 * becomes a candidate, and the builder's record loses its handlers' parameter types.
 */
type NoHandler<R> = { readonly "~list": R };

/**
 * One action's handler, owing `R` per request; a list takes none. It is `Handler` written out, as
 * `Authorizer`'s are. While `implement` infers, an alias whose argument `R` is not yet
 * inferred is marked, as a whole, as not inferrable (the mark `NoHandler` relies on), so an
 * `Effect.fn(...)` a builder returns would infer nothing from it and take an `any` input.
 */
type Single<T extends Target, R> = T extends Any
  ? (
      input: T["input"]["Type"],
    ) => Effect.Effect<T["success"]["Type"], T["error"][number]["Type"] | BuiltIn, R>
  : NoHandler<R>;

/**
 * A record of handlers, one per key of `RequestServices`, each typed from its own action and
 * owing its entry of `RequestServices` per request. TypeScript infers `RequestServices` from the
 * record, key by key, so each handler, `Effect.fn` included, is typed from its contract; a key
 * no action names takes nothing.
 */
type Several<T extends Target, RequestServices> = {
  readonly [K in keyof RequestServices]: K extends NamesOf<T>
    ? Handler<Extract<ActionsOf<T>, { readonly name: K }>, RequestServices[K]>
    : never;
};

/** What `implement` binds to `T`: one action's handler, or a list's record. */
type HandlersOf<T extends Target, R, RequestServices> = Single<T, R> | Several<T, RequestServices>;

/**
 * `T`, never inferred from where it stands: an index TypeScript cannot read until `T` is
 * known, as `NoInfer` would be, but read as `T` itself once it is. So an implementation
 * written inside a surface's arguments takes nothing from what that surface accepts, and a
 * union of services is one union, which `Layer.provide` discharges a member at a time.
 */
type Deferred<T> = [T][T extends unknown ? 0 : never];

/**
 * An authorizer, or an Effect that builds it, as a builder builds handlers: `EAX` and `RAX` are
 * startup failures and services, `RA` what the authorizer reads per request. Each authorizer is
 * `Authorize` written out. TypeScript would infer `RA` from only one branch of a conditional
 * authorizer whose other branch is typed `Authorize`, such as
 * `enabled ? authorize : Action.allowAll`. While `implement` infers, an alias whose argument `RA`
 * is not yet inferred is marked, as a whole, as not inferrable, so an `Effect.fn(...)` the
 * Effect returns would infer nothing from it and take an `any` action.
 */
type Authorizer<A extends Any, RA, EAX, RAX> =
  | ((action: A) => Effect.Effect<void, Refusal, RA>)
  | Effect.Effect<(action: A) => Effect.Effect<void, Refusal, RA>, EAX, RAX>;

/**
 * What `implement` returns for `T`: its handlers' per-request requirements keyed by action
 * name, the authorizer's under `~authorize`, and the startup failures and services of the
 * builder and the authorizer.
 */
type Implemented<T extends Target, RequestServices, R, EX, RX, RA, EAX, RAX> = Implementation<
  ActionsOf<T>,
  // Each call has a scope of its own, so `Scope` is never a request-time requirement.
  {
    readonly [K in NamesOf<T> | "~authorize"]: Exclude<
      | (K extends "~authorize"
          ? RA
          : T extends ReadonlyArray<Any>
            ? RequestServices[K & keyof RequestServices]
            : R)
      | AuthorizerOwed<K, RA>,
      Scope.Scope
    >;
  },
  Deferred<EX>,
  Deferred<Exclude<RX, Scope.Scope>>,
  Deferred<EAX>,
  Deferred<Exclude<RAX, Scope.Scope>>
>;

/** What `implement` receives as authorization, erased. */
type ErasedAuthorizer = ErasedAuthorize | Effect.Effect<ErasedAuthorize, unknown, unknown>;

/** What `implement` receives, erased: one handler, or a record of them. */
type Built = ErasedHandlers<unknown> | ErasedHandler<unknown>;

/**
 * Every authenticated caller may call a protected action. The contract's identity
 * requirement is enforced independently, including when its handler reads no identity.
 */
export const allowAll: Authorize<Any> = () => Effect.void;

/**
 * `authorize`, checked: the types require a function, and plain JavaScript can still pass
 * none, which must not serve every caller.
 */
const assertAuthorizer = (before: ErasedAuthorize): ErasedAuthorize => {
  if (!Predicate.isFunction(before)) {
    throw new Error("Missing authorize: pass an authorization function, or Action.allowAll");
  }

  return before;
};

/** `authorize`, present wherever a protected action is implemented. */
const assertAuthorization = (authorize: ErasedAuthorizer | undefined): ErasedAuthorizer => {
  if (authorize === undefined)
    throw new Error("Protected actions require authorize, or Action.allowAll");

  return authorize;
};

/** No `authorize` where only public actions are implemented: it would never run. */
const assertNoAuthorization = (authorize: ErasedAuthorizer | undefined): ErasedAuthorizer => {
  if (authorize !== undefined) throw new Error("A public-only target takes no authorize");

  return allowAll;
};

/**
 * The layer building `authorize`: a plain function as it is, a built one once its Effect
 * runs, checked when the layer builds, as a builder's record is. `Effect.isEffect` tells them
 * apart, so one written with `Effect.fn` stays plain.
 */
const authorizerOf = (before: ErasedAuthorizer) =>
  memoized(
    Effect.isEffect(before)
      ? Effect.map(before, assertAuthorizer)
      : Effect.succeed(assertAuthorizer(before)),
  );

/**
 * Bind handlers to contracts, behind authorization. Pass one action and its handler, or a list of
 * actions and a record of handlers keyed by action name. Either may instead be an Effect
 * that builds them: its services are startup requirements, resolved once per layer graph
 * however many surfaces serve the result, while services a handler yields are per-request
 * requirements.
 *
 * `authorize` is required when the target includes protected contracts and runs only for
 * them. `Action.allowAll` permits every authenticated caller. An Effect may build the
 * authorizer once, with startup requirements separate from its per-call requirements.
 */
// First, so an authorizer is typed from it: an `Effect.fn` infers its action here, and the
// diagnostic overload, last, cannot stand in for it.
export function implement<
  const T extends Target,
  // A list's record has a handler for each of its actions; one action takes no record.
  RequestServices extends (T extends ReadonlyArray<Any>
    ? { readonly [K in NamesOf<T>]: unknown }
    : never),
  R = never,
  EX = never,
  RX = never,
  RA = never,
  EAX = never,
  RAX = never,
>(
  actions: T,
  handlers:
    | HandlersOf<T, R, RequestServices>
    | Effect.Effect<HandlersOf<T, R, RequestServices>, EX, RX>,
  options: {
    // A public-only target is never authorized, so it takes none: the other overload.
    readonly authorize: [Protected<ActionsOf<T>>] extends [never]
      ? never
      : Authorizer<Protected<ActionsOf<T>>, RA, EAX, RAX>;
  },
): Implemented<T, RequestServices, R, EX, RX, RA, EAX, RAX>;
export function implement<
  const T extends ProtectedActionsTakeAuthorize,
  // A list's record has a handler for each of its actions; one action takes no record.
  RequestServices extends (T extends ReadonlyArray<Any>
    ? { readonly [K in NamesOf<T>]: unknown }
    : never),
  R = never,
  EX = never,
  RX = never,
  RA = never,
  EAX = never,
  RAX = never,
>(
  actions: T,
  handlers:
    | HandlersOf<T, R, RequestServices>
    | Effect.Effect<HandlersOf<T, R, RequestServices>, EX, RX>,
  // Public actions are never authorized.
  options?: { readonly authorize?: never },
): Implemented<T, RequestServices, R, EX, RX, RA, EAX, RAX>;
// The general overload again, last, so a call matching none is reported against it: a
// misspelled `authorize` as an unknown key, and one given to public actions by its message.
export function implement<
  const T extends Target,
  // A list's record has a handler for each of its actions; one action takes no record.
  RequestServices extends (T extends ReadonlyArray<Any>
    ? { readonly [K in NamesOf<T>]: unknown }
    : never),
  R = never,
  EX = never,
  RX = never,
  RA = never,
  EAX = never,
  RAX = never,
>(
  actions: T,
  handlers:
    | HandlersOf<T, R, RequestServices>
    | Effect.Effect<HandlersOf<T, R, RequestServices>, EX, RX>,
  options: {
    readonly authorize: [Protected<ActionsOf<T>>] extends [never]
      ? "A public-only target takes no authorize"
      : Authorizer<Protected<ActionsOf<T>>, RA, EAX, RAX>;
  },
): Implemented<T, RequestServices, R, EX, RX, RA, EAX, RAX>;
export function implement(
  actions: Target,
  handlers: Built | Effect.Effect<Built, unknown, unknown>,
  options?: { readonly authorize?: ErasedAuthorizer },
): Implementation<Any, {}, unknown, unknown, unknown, unknown> {
  const listed = Arr.ensure(actions);
  const names = listed.map((action) => action.name);

  assertOnce("action", listed);

  const authorizer = authorizerOf(
    listed.some((action) => action.caller !== Anyone)
      ? assertAuthorization(options?.authorize)
      : assertNoAuthorization(options?.authorize),
  );

  // Handlers are keyed by action name; a single action's handler is its own record. A
  // key no action names is refused, so a stale handler cannot outlive its action, and so
  // is an action without a handler. The result pairs each action with its handler.
  const record = (built: Built): Bound => {
    const keyed: ErasedHandlers<unknown> = Predicate.isFunction(built)
      ? Object.fromEntries(Array.isArray(actions) ? [] : listed.map(({ name }) => [name, built]))
      : built;

    assertKnown("handlers", Object.keys(keyed), names);

    // Own-property functions only: an inherited method is not a handler.
    const bound = listed.flatMap((action) => {
      const handle = Object.hasOwn(keyed, action.name) ? keyed[action.name] : undefined;

      return Predicate.isFunction(handle) ? [[action, handle] as const] : [];
    });

    const missing = names.filter((name) => !bound.some(([action]) => action.name === name));

    if (missing.length > 0) throw new Error(`Missing handlers: ${missing.join(", ")}`);

    return bound;
  };

  // Plain handlers are checked here; a builder's record when it is built.
  const recorded = Effect.isEffect(handlers)
    ? Effect.map(handlers, record)
    : Effect.succeed(record(handlers));

  return new Implementation(listed, memoized(recorded), authorizer);
}

/**
 * The builders of `implementations`, as one layer providing nothing. Surfaces build them
 * themselves, once per layer graph, but routes under `HttpRouter.serve` or `Testing.layer`
 * are built in a graph of their own: provided above both, it runs each builder once for every
 * surface, with the services it is given.
 */
export function layer<const Apps extends Served>(
  implementations: Apps,
): Layer.Layer<never, BuildError<Member<Apps>>, BuildServices<Member<Apps>>>;
export function layer(implementations: Served): Layer.Layer<never, unknown, unknown> {
  return builders(toList(implementations));
}

/**
 * One call of `A` in process: its decoded success, or its declared errors and the built-in
 * ones, owing `R` per call, what its handler and its implementation's `authorize` read.
 */
type Method<A extends Any, R> = Call<
  A,
  Effect.Effect<A["success"]["Type"], A["error"][number]["Type"] | BuiltIn, R>
>;

/**
 * Every action of the implementations `Apps`, one or a list, as `client.<action>(input)`: what
 * `client` gives, each method owing per call what its handler and `authorize` read.
 */
export type Client<
  Apps extends Served,
  Listed extends Any = Extract<ActionOf<Member<Apps>>, Any>,
> = {
  readonly [A in Serving<Member<Apps>, Listed> as A["name"]]: Method<A, RequestOf<Member<Apps>, A>>;
};

/** A client method, erased: the implementations' actions restore its exact type. */
type ErasedMethod = (
  ...input: ReadonlyArray<ErasedValue>
) => Effect.Effect<ErasedValue, unknown, unknown>;

/**
 * A value through `schema`'s JSON codec, as a wire carries it: encoded to JSON text, then
 * decoded, so what comes out is what a remote call's other side decodes, `-0` as `0`. Every
 * issue is reported.
 */
const wire = (schema: Codec) => {
  const codec = Schema.fromJsonString(Schema.toCodecJson(schema));
  const encode = Schema.encodeUnknownEffect(codec, { errors: "all" });
  const decode = Schema.decodeUnknownEffect(codec, { errors: "all" });

  return (value: ErasedValue) => Effect.flatMap(encode(value), (encoded) => decode(encoded));
};

/**
 * `cause` with each failure passed through `failure` where it stands, so it keeps its
 * annotations, the span it failed in among them; failed anew, it would lose them. One that
 * passes keeps the stack of where it was made, where the decoded error's would be the codec's.
 * One that does not, such as an error the action does not declare, is a defect: its
 * `SchemaError`, then the failure itself.
 */
const mapFailures = (
  cause: Cause.Cause<unknown>,
  failure: (error: ErasedValue) => Effect.Effect<ErasedValue, Schema.SchemaError>,
): Effect.Effect<Cause.Cause<unknown>> =>
  Effect.map(
    Effect.forEach(cause.reasons, (reason) =>
      Cause.isFailReason(reason)
        ? Effect.match(failure(reason.error), {
            onFailure: (refused) => Cause.combine(Cause.die(refused), Cause.die(reason.error)),
            onSuccess: (decoded) =>
              Cause.fail(
                Predicate.isError(reason.error) && Predicate.isError(decoded)
                  ? Object.assign(decoded, { stack: reason.error.stack })
                  : decoded,
              ),
          }).pipe(Effect.map((mapped) => Cause.annotate(mapped, Cause.reasonAnnotations(reason))))
        : Effect.succeed(Cause.fromReasons([reason])),
    ),
    (causes) => Cause.fromReasons(causes.flatMap(({ reasons }) => reasons)),
  );

/**
 * `action`'s method, running `run`, its handler behind authorization, as a remote
 * call runs: input that does not pass through its codec is `InvalidInput`, and nothing else
 * runs; a success or a failure that does not is a defect, as it is an empty 500 over HTTP,
 * since the handler broke its contract. A failure passes through the codec of
 * every error the action declares, the built-in ones included.
 */
const methodOf = (action: Any, run: ErasedHandler<unknown>): ErasedMethod => {
  const input = wire(action.input);
  const success = wire(action.success);
  const failure = wire(Schema.Union(projectedErrors(action)));

  return (...args) =>
    inputOf(action, args).pipe(
      Effect.flatMap(input),
      Effect.mapError(InvalidInput.fromSchemaError),
      Effect.flatMap((value) =>
        Effect.catchCause(run(value), (cause) =>
          Effect.flatMap(mapFailures(cause, failure), Effect.failCause),
        ),
      ),
      Effect.flatMap((value) => Effect.orDie(success(value))),
    );
};

/** What `client` takes: the actions to call. */
export interface ClientOptions<A extends Any> {
  /**
   * The actions to call, among the implementations': `[GetUser]`. Defaults to every action of
   * them. Options whose `actions` may be absent are typed as every action, as they may run.
   */
  readonly actions?: ReadonlyArray<A> | undefined;
}

/**
 * Call implementations in process: one method per action, taking its input directly, as
 * `ActionHttp.client`'s methods do, `client.renameUser({ id, name })`, so moving between the
 * two changes the line acquiring it. A call runs as a remote one does: its input passes through
 * its JSON codec, encoded then decoded, then the implementation's `authorize` and the handler
 * run, in a scope of their own, and the success or the failure passes through its
 * codec. It fails with the action's errors and the built-in ones, and owes, per call, what
 * they read, the caller's identity included; the caller provides it around the call.
 *
 * Acquiring it builds the implementations' builders, as a layer does, into the layer graph it
 * is acquired in, and its scope holds them: in a builder, it shares their one run with every
 * surface of that graph. Acquire it where builders live, in a builder, a layer or a scoped
 * program, never per request.
 */
export function client<
  const Apps extends Served,
  const O extends ClientOptions<ActionOf<Member<Apps>>> = {},
>(
  implementations: Apps,
  ...options: OptionalUnless<
    O,
    ClientOptions<ActionOf<Member<Apps>>> & O & NoInfer<Known<O, ClientOptions<Any>>>
  >
): Effect.Effect<
  Client<Apps, Offered<O, ActionOf<Member<Apps>>>>,
  BuildError<Holding<Member<Apps>, SelectedOf<O, Apps>>, SelectedOf<O, Apps>>,
  BuildServices<Holding<Member<Apps>, SelectedOf<O, Apps>>, SelectedOf<O, Apps>> | Scope.Scope
>;
export function client(
  served: Served,
  options?: { readonly actions?: ReadonlyArray<Any> | undefined },
): Effect.Effect<{ readonly [name: string]: ErasedMethod }, unknown, unknown> {
  const apps = select(toList(served), options?.actions);

  // Checked where it is made, as a surface checks the names it serves.
  assertOnce(
    "action",
    apps.flatMap((app) => app.actions),
  );

  return Effect.map(built(apps), (bound) =>
    Object.fromEntries(bound.map(([action, run]) => [action.name, methodOf(action, run)])),
  );
}
