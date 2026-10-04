import { Array as Arr, Cause, Effect, type Layer, Predicate, Schema, type Types } from "effect";
import type { Scope } from "effect";
import {
  assertErrors,
  assertKnown,
  assertName,
  assertOnce,
  projectedErrors,
} from "./internal/actions.js";
import { type Call, inputOf } from "./internal/call.js";
import { type BuiltIn, type BuiltIns, InvalidInput, type Refusal } from "./internal/errors.js";
import {
  type ActionOf,
  type AnyImplementation,
  type Before,
  type Bound,
  type BuildContext,
  type BuildError,
  builders,
  built,
  type HookErrors,
  type ErasedBefore,
  type ErasedHandler,
  type ErasedValue,
  type Handlers,
  Implementation,
  type Member,
  memoized,
  type RequestOf,
  type Served,
  toList,
} from "./internal/implementation.js";

/** An action bound to its handler; opaque, see `implement`. */
export type { Implementation } from "./internal/implementation.js";

/**
 * An implementation's hook: whether a caller may call. It receives the selected action and
 * fails with a refusal, or with an error its actions declare, such as a rate limit, which a
 * call of an action that does not declare it gets as a defect; its services are request-time requirements, like a handler's. `implement` and
 * `share` also take an Effect building one, whose services are startup requirements, like a
 * builder's.
 */
export type { Before } from "./internal/implementation.js";

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
 * What an action does to the resource it serves: `"read"` observes, `"write"`
 * may change it. Authorization metadata, not a tool hint.
 */
export type Access = "read" | "write";

/**
 * Tool hints; every field has a default derived from the action. `readOnlyHint` is not
 * one: it is always `access === "read"`, so a tool cannot say otherwise than its contract.
 */
export interface Hints {
  /** `destructiveHint`, a write's only; defaults to `true`. A read is never destructive. */
  readonly destructive?: boolean;
  /** `idempotentHint`; defaults to `false`. */
  readonly idempotent?: boolean;
  /** `openWorldHint`; defaults to `true`. */
  readonly openWorld?: boolean;
  /**
   * MCP only: a top-level string field of the encoded success, which the tool sends once,
   * raw, as the first text block, then the JSON of the rest as the second, with no
   * `structuredContent` and no listed `outputSchema`, so every host shows the model both: a
   * body the model reads as it is, such as a page of Markdown. Defaults to none.
   */
  readonly text?: string | undefined;
}

/** The keys `E` declares, leaving out an index signature's. */
type DeclaredKey<E> = keyof {
  [
    K in keyof E as string extends K
      ? never
      : number extends K
        ? never
        : symbol extends K
          ? never
          : K
  ]: E[K];
};

/**
 * The fields of an encoded success `E` its tool may send as text: the top-level string fields
 * a struct or class declares, optional ones included, and not the keys of an index signature,
 * such as a struct with rest's record. None of any other success, a union or a record among
 * them, whose JSON Schema has no top-level property for it. An erased success may name any;
 * the MCP server refuses what the types cannot see when its layer is built.
 */
type TextField<E> = unknown extends E
  ? string
  : true extends Types.IsUnion<E>
    ? never
    : E extends ReadonlyArray<unknown>
      ? never
      : E extends object
        ? {
            readonly [K in DeclaredKey<E>]-?: Required<E>[K] extends string ? K : never;
          }[DeclaredKey<E>] &
            string
        : never;

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
  readonly description: string;
  /** A schema or struct fields. Omit, or give `{}`, for an action without arguments. */
  readonly input?: Codec | Fields | undefined;
  /** A schema or struct fields. Omit for an action that returns nothing: `Schema.Void`. */
  readonly success?: Codec | Fields | undefined;
  /**
   * One schema per declared failure; each keeps its own HTTP status annotation. Defaults to
   * none. Each `_tag` once, and none of a built-in error's.
   */
  readonly errors?: ReadonlyArray<Codec> | undefined;
  /**
   * What the action does to its resource. Required: an action nobody classified
   * is the one a reviewer must check. Read by an implementation's `before` hook; the
   * library itself authorizes nothing.
   */
  readonly access: Access;
  /**
   * Tool hints, for MCP and native Toolkit tools. The tool is named after the action. Only
   * a write may state `destructive`, as MCP defines it for writes.
   */
  readonly hints?: Hints;
}

/**
 * No key beyond `Keys`, so a misspelled option or hint is refused rather than ignored.
 * Checked after inference: `make`'s options are `O & NoInfer<Rules<O>>`.
 */
type Known<O, Keys> = { readonly [K in Exclude<keyof O, keyof Keys>]: never };

/**
 * The keys beyond `Hints` in the hints of any member of `O`, given or optional, so a
 * misspelled hint in a conditional spread or in one branch of a ternary is refused too.
 */
type UnknownHints<O> = O extends { readonly hints?: infer H }
  ? Exclude<H extends unknown ? keyof H : never, keyof Hints>
  : never;

/** No hint beyond `Hints`, whichever member of `O` gives it. */
type KnownHints<O> = { readonly hints?: { readonly [K in UnknownHints<O>]: never } };

/**
 * A `text` hint naming a top-level string field of the encoded success. One typed only as
 * `string`, such as hints built apart, is left for the MCP server to check.
 */
type TextHint<O> = O extends { readonly hints?: { readonly text?: infer F } }
  ? string extends F
    ? unknown
    : {
        readonly hints?: {
          readonly text?: TextField<SchemaOf<O, "success", typeof Schema.Void>["Encoded"]>;
        };
      }
  : unknown;

/**
 * The built-in errors, refused in `errors`: every surface declares them already. The types
 * refuse only the built-ins themselves; `make` refuses, when called, an error of your own
 * that encodes with a built-in `_tag`.
 */
type OwnErrors<O> = O extends { readonly errors: ReadonlyArray<infer E> }
  ? [Extract<E, BuiltIns>] extends [never]
    ? unknown
    : { readonly errors: ReadonlyArray<Exclude<E, BuiltIns>> }
  : unknown;

/**
 * The rules `make` checks beyond `Options`: every option and hint known, a read never
 * destructive, a `text` hint a string field of the success, and no built-in error listed. Options that fail `Options` itself infer as
 * `Options`, whose error the compiler already reports, so they are not checked again.
 */
type Rules<O> = Options extends O
  ? unknown
  : Known<O, Options> &
      OwnErrors<O> &
      KnownHints<O> &
      TextHint<O> &
      (O extends { readonly access: "read" }
        ? { readonly hints?: { readonly destructive?: never } }
        : unknown);

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
type ErrorsOf<O> = Extract<OptionOf<O, "errors", []>, ReadonlyArray<Codec>>;

/** A pure contract: schemas and transport metadata. Handlers are bound by `implement`. */
export interface Action<
  Name extends string,
  Input extends Codec,
  Success extends Codec,
  Errors extends ReadonlyArray<Codec>,
  Acc extends Access = Access,
> {
  readonly name: Name;
  readonly description: string;
  readonly input: Input;
  readonly success: Success;
  readonly errors: Errors;
  // Declared, never defaulted, so a rule that switches on it reads a literal
  // rather than the runtime values the hints are.
  readonly access: Acc;
  readonly hints: Required<Hints>;
}

/** Any action, with its schemas erased. */
export type Any = Action<string, Codec, Codec, ReadonlyArray<Codec>>;

/** Receives decoded input; may fail only with the declared errors and the built-in ones. */
export type Handler<A extends Any, R = never> = (
  input: A["input"]["Type"],
) => Effect.Effect<A["success"]["Type"], A["errors"][number]["Type"] | BuiltIn, R>;

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
  O["access"]
>;
export function make(name: string, options: Options): Any {
  assertName("action name", name);

  const { access } = options;

  // The type is the only thing stopping a third value, and a plain-JavaScript
  // caller has none: an unclassified action must not reach a hook that reads it.
  if (access !== "read" && access !== "write") throw new Error(`Invalid access: ${String(access)}`);

  const hints = {
    // Plain JavaScript can pass `destructive` for a read too; it is still not one.
    destructive: access === "write" && (options.hints?.destructive ?? true),
    idempotent: options.hints?.idempotent ?? false,
    openWorld: options.hints?.openWorld ?? true,
    text: options.hints?.text,
  };

  const action: Any = {
    name,
    description: options.description,
    input: codecOf(options.input ?? {}),
    success: options.success === undefined ? Schema.Void : codecOf(options.success),
    errors: options.errors ?? [],
    access,
    hints,
  };

  assertErrors(action);

  return action;
}

/** What `implement` binds: one action, or several that share one builder. */
type Target = Any | ReadonlyArray<Any>;

/**
 * The actions `T` stands for. One action is extracted rather than taken as it is, so where `T`
 * is deferred, such as a list of a helper's type parameter, the actions are still actions to
 * TypeScript, and a share of them reaches a surface.
 */
type ActionsOf<T extends Target> = T extends ReadonlyArray<Any> ? T[number] : Extract<T, Any>;

/** The names of the actions `T` stands for. */
type NamesOf<T extends Target> = ActionsOf<T>["name"];

/**
 * What a name `K` owes per request for the hook, `RB`, besides its handler's: nothing, as the
 * hook's requirements have a key of their own, unless `K` is `string`. Names typed only as
 * `string`, such as an `Action.Any`'s, absorb that key, so each owes the hook's too.
 */
type HookOwed<K, RB> = string extends K ? RB : never;

/**
 * What a list takes instead of one handler: nothing. A named alias carrying `R`, and it must
 * stay one: while a builder's inner call, such as `Effect.gen`, is inferred, TypeScript keeps
 * an alias's arguments marked as not yet inferred, where `never` or this type written inline
 * becomes a candidate, and the builder's record loses its handlers' parameter types.
 */
type NoHandler<R> = { readonly "~list": R };

/**
 * One action's handler, owing `R` per request; a list takes none. It is `Handler` written
 * out, as `Hook`'s hooks are. While `implement` infers, an alias whose argument `R` is not yet
 * inferred is marked, as a whole, as not inferrable (the mark `NoHandler` relies on), so an
 * `Effect.fn(...)` a builder returns would infer nothing from it and take an `any` input.
 */
type Single<T extends Target, R> = T extends Any
  ? (
      input: T["input"]["Type"],
    ) => Effect.Effect<T["success"]["Type"], T["errors"][number]["Type"] | BuiltIn, R>
  : NoHandler<R>;

/**
 * A record of handlers, one per key of `R`, each typed from its own action and owing its
 * entry of `R` per request. TypeScript infers `R` from the record, key by key, so each
 * handler, `Effect.fn` included, is typed from its contract; a key no action names takes
 * nothing.
 */
type Several<T extends Target, R> = {
  readonly [K in keyof R]: K extends NamesOf<T>
    ? Handler<Extract<ActionsOf<T>, { readonly name: K }>, R[K]>
    : never;
};

/** What `implement` binds to `T`: one action's handler, or a list's record. */
type HandlersOf<T extends Target, RS, R> = Single<T, RS> | Several<T, R>;

/**
 * `T`, never inferred from where it stands: an index TypeScript cannot read until `T` is
 * known, as `NoInfer` would be, but read as `T` itself once it is. So an implementation
 * written inside a surface's arguments takes nothing from what that surface accepts, and a
 * union of services is one union, which `Layer.provide` discharges a member at a time.
 */
type Deferred<T> = [T][T extends unknown ? 0 : never];

/**
 * A hook, or an Effect that builds it, as a builder builds handlers: `EB` and `RBX` are
 * startup failures and services, `RB` what the hook reads per request. Each hook is `Before`
 * written out. TypeScript would infer `RB` from only one branch of a conditional hook whose
 * other branch is typed `Before`, such as `enabled ? authorize : Action.allowAll`. While
 * `implement` infers, an alias whose argument `RB` is not yet inferred is marked, as a whole,
 * as not inferrable, so an `Effect.fn(...)` the Effect returns would infer nothing from it and
 * take an `any` action.
 */
type Hook<A extends Any, RB, EB, RBX> =
  | ((action: A) => Effect.Effect<void, Refusal | HookErrors<A>, RB>)
  | Effect.Effect<(action: A) => Effect.Effect<void, Refusal | HookErrors<A>, RB>, EB, RBX>;

/** What `implement` and `share` receive as a hook, erased. */
type ErasedHook = ErasedBefore | Effect.Effect<ErasedBefore, unknown, unknown>;

/** What `implement` receives, erased: one handler, or a record of them. */
type Built = Handlers<unknown> | ErasedHandler<unknown>;

/**
 * The hook that decides nothing: every caller a surface admits may call. Authentication
 * around the surface still decides who is admitted. State it where an implementation needs
 * no action-level rule, as `enabled ? authorize : Action.allowAll` does where one depends
 * on the deployment.
 */
export const allowAll: Before<Any> = () => Effect.void;

/**
 * `before`, checked: the types require a hook, and plain JavaScript can still pass none,
 * which must not serve every caller.
 */
const assertHook = (before: ErasedBefore): ErasedBefore => {
  if (!Predicate.isFunction(before)) {
    throw new Error("Missing hook: pass an authorization hook, or Action.allowAll");
  }

  return before;
};

/**
 * The layer building `before`: a plain hook as it is, a built one once its Effect runs,
 * checked when the layer builds, as a builder's record is. `Effect.isEffect` tells them
 * apart, so a hook written with `Effect.fn` stays plain.
 */
const hookOf = (before: ErasedHook) =>
  memoized(
    Effect.isEffect(before) ? Effect.map(before, assertHook) : Effect.succeed(assertHook(before)),
  );

/**
 * Bind handlers to contracts, behind a hook. Pass one action and its handler, or a list of
 * actions and a record of handlers keyed by action name. Either may instead be an Effect
 * that builds them: its services are startup requirements, resolved once per layer graph
 * however many surfaces serve the result, while services a handler yields are per-request
 * requirements.
 *
 * `before` is the implementation's hook, which every surface serving it runs before each
 * handler: whether the caller may call. It is required: `Action.allowAll` says every caller
 * may. It may also be an Effect that builds the hook, as a builder builds handlers.
 */
export function implement<
  const T extends Target,
  // A list's record has a handler for each of its actions; one action takes no record.
  R extends (T extends ReadonlyArray<Any> ? { readonly [K in NamesOf<T>]: unknown } : never),
  RS = never,
  EX = never,
  RX = never,
  RB = never,
  EB = never,
  RBX = never,
>(
  target: T,
  build: HandlersOf<T, RS, R> | Effect.Effect<HandlersOf<T, RS, R>, EX, RX>,
  before: Hook<ActionsOf<T>, RB, EB, RBX>,
): Implementation<
  ActionsOf<T>,
  // Each call has a scope of its own, so `Scope` is never a request-time requirement.
  {
    readonly [K in NamesOf<T> | "~hook"]: Exclude<
      | (K extends "~hook" ? RB : T extends ReadonlyArray<Any> ? R[K & keyof R] : RS)
      | HookOwed<K, RB>,
      Scope.Scope
    >;
  },
  Deferred<EX>,
  Deferred<Exclude<RX, Scope.Scope>>,
  Deferred<EB>,
  Deferred<Exclude<RBX, Scope.Scope>>
>;
export function implement(
  target: Target,
  build: Built | Effect.Effect<Built, unknown, unknown>,
  before: ErasedHook,
): Implementation<Any, {}, unknown, unknown, unknown, unknown> {
  const actions = Arr.ensure(target);
  const names = actions.map((action) => action.name);

  assertOnce("action", actions);

  const hook = hookOf(before);

  // Handlers are keyed by action name; a single action's handler is its own record. A
  // key no action names is refused, so a stale handler cannot outlive its action, and so
  // is an action without a handler. The result pairs each action with its handler.
  const record = (built: Built): Bound => {
    const handlers: Handlers<unknown> = Predicate.isFunction(built)
      ? Object.fromEntries(Array.isArray(target) ? [] : actions.map(({ name }) => [name, built]))
      : built;

    assertKnown("handlers", Object.keys(handlers), names);

    // Own-property functions only: an inherited method is not a handler.
    const bound = actions.flatMap((action) => {
      const handle = Object.hasOwn(handlers, action.name) ? handlers[action.name] : undefined;

      return Predicate.isFunction(handle) ? [[action, handle] as const] : [];
    });

    const missing = names.filter((name) => !bound.some(([action]) => action.name === name));

    if (missing.length > 0) throw new Error(`Missing handlers: ${missing.join(", ")}`);

    return bound;
  };

  // Plain handlers are checked here; a builder's record when it is built.
  const handlers = Effect.isEffect(build)
    ? Effect.map(build, record)
    : Effect.succeed(record(build));

  return new Implementation(actions, memoized(handlers), hook);
}

/**
 * Serve some of `app`'s actions with its handlers, behind its hook, or `before` instead:
 * `share([Poll], users)` for a surface serving fewer actions, `share(actions, users,
 * trustAdmin)` for an admin CLI, `share([Poll], users, Action.allowAll)` for a public one.
 * The result shares `app`'s builder, which runs once per layer graph however many
 * implementations share it; `before` may be built, as `implement`'s may. Per request, it owes
 * what `app`'s handlers owe for its actions, and what its hook owes, `app`'s or `before`'s; at
 * startup, what `app`'s builder needs, and what building its hook does, `app`'s or `before`'s.
 */
export function share<App extends AnyImplementation, const T extends Target>(
  target: T,
  app: App,
): Implementation<
  ActionsOf<T>,
  { readonly [K in NamesOf<T> | "~hook"]: App["~request"][K & keyof App["~request"]] },
  App["~buildError"],
  App["~buildContext"],
  App["~hookBuildError"],
  App["~hookBuildContext"]
>;
export function share<
  App extends AnyImplementation,
  const T extends Target,
  RB = never,
  EB = never,
  RBX = never,
>(
  target: T,
  app: App,
  before: Hook<ActionsOf<T>, RB, EB, RBX>,
): Implementation<
  ActionsOf<T>,
  // Each call has a scope of its own, so `Scope` is never a request-time requirement. A name
  // typed only as `string` reads every key but the source's hook's, which `before` replaces.
  {
    readonly [K in NamesOf<T> | "~hook"]: K extends "~hook"
      ? Exclude<RB, Scope.Scope>
      :
          | App["~request"][K & Exclude<keyof App["~request"], "~hook">]
          | HookOwed<K, Exclude<RB, Scope.Scope>>;
  },
  App["~buildError"],
  App["~buildContext"],
  Deferred<EB>,
  Deferred<Exclude<RBX, Scope.Scope>>
>;
export function share(
  target: Target,
  app: AnyImplementation,
  ...before: [] | [ErasedHook]
): Implementation<Any, {}, unknown, unknown, unknown, unknown> {
  const actions = Arr.ensure(target);

  assertOnce("action", actions);

  // Refused here rather than in the types, so a helper may share what its type parameters
  // stand for.
  const unknown = actions.filter((action) => !app.actions.includes(action));

  if (unknown.length > 0) {
    throw new Error(
      `Not implemented by this implementation: ${unknown.map(({ name }) => name).join(", ")}`,
    );
  }

  // Left out, the hook is the source's; given, even as `undefined`, it is checked, as
  // `implement` checks its own.
  return Implementation.share(actions, app, before.length === 0 ? undefined : hookOf(before[0]));
}

/**
 * The builders of `implementations`, as one layer providing nothing. Surfaces build them
 * themselves, once per layer graph, but routes under `HttpRouter.serve` or `Testing.layer`
 * are built in a graph of their own: provided above both, it runs each builder once for every
 * surface, with the services it is given.
 */
export function layer<const Apps extends Served>(
  implementations: Apps,
): Layer.Layer<never, BuildError<Member<Apps>>, BuildContext<Member<Apps>>>;
export function layer(implementations: Served): Layer.Layer<never, unknown, unknown> {
  return builders(toList(implementations));
}

/**
 * One call of `A` in process: its decoded success, or its declared errors and the built-in
 * ones, owing `R` per call, what its handler and its implementation's hook read.
 */
type Method<A extends Any, R> = Call<
  A,
  Effect.Effect<A["success"]["Type"], A["errors"][number]["Type"] | BuiltIn, R>
>;

/**
 * Every action of the implementations `Apps`, one or a list, as `client.<action>(input)`: what
 * `client` gives, each method owing per call what its handler and its hook read.
 */
export type Client<Apps extends Served> = {
  readonly [A in Extract<ActionOf<Member<Apps>>, Any> as A["name"]]: Method<
    A,
    RequestOf<Member<Apps>, A>
  >;
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
 * `action`'s method, running `run`, its handler behind its hook, as a remote call runs: input
 * that does not pass through its codec is `InvalidInput`, and the hook and the handler never
 * run; a success or a failure that does not is a defect, as it is an empty 500 over HTTP,
 * since the handler or the hook broke its contract. A failure passes through the codec of
 * every error the action declares, the built-in ones included.
 */
const methodOf = (action: Any, run: ErasedHandler<unknown>): ErasedMethod => {
  const input = wire(action.input);
  const success = wire(action.success);
  const failure = wire(Schema.Union(projectedErrors(action)));

  return (...args) =>
    inputOf(action, args).pipe(
      Effect.flatMap(input),
      Effect.mapError(({ message }) => new InvalidInput({ message })),
      Effect.flatMap((value) =>
        Effect.catchCause(run(value), (cause) =>
          Effect.flatMap(mapFailures(cause, failure), Effect.failCause),
        ),
      ),
      Effect.flatMap((value) => Effect.orDie(success(value))),
    );
};

/**
 * Call implementations in process: one method per action, taking its input directly, as
 * `ActionHttp.client`'s methods do, `client.renameUser({ id, name })`, so moving between the
 * two changes the line acquiring it. A call runs as a remote one does: its input passes through
 * its JSON codec, encoded then decoded, then the implementation's hook and the handler run, in
 * a scope of their own, and the success or the failure passes through its codec. It fails
 * with the action's errors and the built-in ones, and owes, per call, what the handler and the
 * hook read, the caller's identity included; the caller provides it around the call.
 *
 * Acquiring it builds the implementations' builders, as a layer does, into the layer graph it
 * is acquired in, and its scope holds them: in a builder, it shares their one run with every
 * surface of that graph. Acquire it where builders live, in a builder, a layer or a scoped
 * program, never per request.
 */
export function client<const Apps extends Served>(
  implementations: Apps,
): Effect.Effect<Client<Apps>, BuildError<Member<Apps>>, BuildContext<Member<Apps>> | Scope.Scope>;
export function client(
  served: Served,
): Effect.Effect<{ readonly [name: string]: ErasedMethod }, unknown, unknown> {
  const apps = toList(served);

  // Checked where it is made, as a surface checks the names it serves.
  assertOnce(
    "action",
    apps.flatMap((app) => app.actions),
  );

  return Effect.map(built(apps), (bound) =>
    Object.fromEntries(bound.map(([action, run]) => [action.name, methodOf(action, run)])),
  );
}
