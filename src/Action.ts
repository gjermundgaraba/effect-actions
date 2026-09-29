import { Effect, Predicate, Schema } from "effect";
import type { Scope } from "effect";
import {
  assertDistinct,
  assertDistinctTags,
  assertName,
  assertOwnTags,
} from "./internal/actions.js";
import type { BuiltIn, BuiltIns } from "./internal/errors.js";
import {
  type ActionOf,
  type AnyImplementation,
  type Before,
  type Bound,
  type ErasedHandler,
  type HandlerContext,
  type Handlers,
  Implementation,
} from "./internal/implementation.js";

/** An action bound to its handler; opaque, see `implement`. */
export type { Implementation } from "./internal/implementation.js";

/**
 * An implementation's hook: whether a caller may call. It receives the selected action and
 * fails only with a refusal; its services are request-time requirements, like a handler's.
 */
export type { Before } from "./internal/implementation.js";

/** Any implementation, with its actions and channels erased: what every surface accepts. */
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
  readonly description: string;
  /** A schema or struct fields. Omit, or give `{}`, for an action without arguments. */
  readonly input?: Codec | Fields | undefined;
  /** A schema or struct fields. Omit for an action that returns nothing: `Schema.Void`. */
  readonly success?: Codec | Fields | undefined;
  /** One schema per declared failure; each keeps its own HTTP status annotation. Defaults to none. */
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
 * No key beyond `Known`, so a misspelled option is refused rather than ignored. Checked
 * after inference, as `Exact` is.
 */
type Known<O, Keys> = { readonly [K in Exclude<keyof O, keyof Keys>]: never };

/**
 * The built-in errors, refused in `errors`: every surface declares them already. A
 * look-alike of your own, which the types cannot tell by its tag, `implement` refuses.
 */
type OwnErrors<O> = O extends { readonly errors: ReadonlyArray<infer E> }
  ? [Extract<E, BuiltIns>] extends [never]
    ? unknown
    : { readonly errors: ReadonlyArray<Exclude<E, BuiltIns>> }
  : unknown;

/**
 * The rules `make` checks beyond `Options`: every option known, a read never destructive,
 * and no built-in error listed. Options that fail `Options` itself infer as `Options`, whose
 * error the compiler already reports, so they are not checked again.
 */
type Rules<O> = Options extends O
  ? unknown
  : Known<O, Options> &
      OwnErrors<O> &
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
  };

  return {
    name,
    description: options.description,
    input: codecOf(options.input ?? {}),
    success: options.success === undefined ? Schema.Void : codecOf(options.success),
    errors: options.errors ?? [],
    access,
    hints,
  };
}

/** What `implement` binds: one action, or several that share one builder. */
type Target = Any | ReadonlyArray<Any>;

/** The actions `T` stands for. */
type ActionsOf<T extends Target> = T extends ReadonlyArray<Any> ? T[number] : T;

/** The handler of one action, or a record of handlers keyed by action name. */
type HandlersFor<T extends Target> =
  T extends ReadonlyArray<Any>
    ? { readonly [A in T[number] as A["name"]]: Handler<A, any> }
    : T extends Any
      ? Handler<T, any>
      : never;

/**
 * Each action's handler's per-request requirements, by name: its entry of `H`, or `H`
 * itself; and the hook's `RB`, under `~hook`, which no action name can be.
 */
type RequestsOf<T extends Target, H, RB> = {
  readonly [K in ActionsOf<T>["name"] | "~hook"]: K extends "~hook"
    ? RB
    : HandlerContext<T extends ReadonlyArray<Any> ? H[K & keyof H] : H>;
};

/** What `S`'s handlers owe for each action of `T`, which it implements, and the hook's `RB`. */
type SharedRequests<T extends Target, S, RB> = S extends { readonly "~request": infer R }
  ? {
      readonly [K in ActionsOf<T>["name"] | "~hook"]: K extends "~hook" ? RB : R[K & keyof R];
    }
  : never;

/** The requirements of `S`'s hook. */
type HookOf<S> = S extends { readonly "~request": infer R } ? R["~hook" & keyof R] : never;

/** The names a handlers record may have: none for a single action's handler. */
type Names<T extends Target> = T extends ReadonlyArray<Any> ? T[number]["name"] : never;

/**
 * A handlers record with no key beyond its actions' names. `H` itself stays the inferred
 * parameter, so handlers are contextually typed and a generic handler such as
 * `Effect.succeed` is still inferred; the check does not take part in inference.
 */
type Exact<T extends Target, H> = H &
  NoInfer<{ readonly [K in Exclude<keyof H, Names<T>>]: never }>;

/** What `implement` receives, erased: one handler, or a record of them. */
type Built = Handlers<unknown> | ErasedHandler<unknown>;

const isList = (target: Target): target is ReadonlyArray<Any> => Array.isArray(target);

/**
 * Bind handlers to contracts. Pass one action and its handler, or a list of actions and
 * a record of handlers keyed by action name. Either may instead be an Effect that builds
 * them: its services are startup requirements, resolved once however many surfaces serve
 * the result, while services a handler yields are per-request requirements.
 *
 * `before` is the implementation's hook, which every surface serving it runs before each
 * handler: whether the caller may call. Omit it for a public implementation.
 */
export function implement<
  const T extends Target,
  H extends HandlersFor<T>,
  EX = never,
  RX = never,
  RB = never,
>(
  target: T,
  build: Exact<T, H> | Effect.Effect<Exact<T, H>, EX, RX>,
  before?: Before<ActionsOf<T>, RB>,
): Implementation<
  ActionsOf<T>,
  RequestsOf<T, H, RB>,
  NoInfer<EX>,
  NoInfer<Exclude<RX, Scope.Scope>>
>;
export function implement(
  target: Target,
  build: Built | Effect.Effect<Built, unknown, unknown>,
  before?: Before<Any, unknown>,
): Implementation<Any, {}, unknown, unknown> {
  const actions = isList(target) ? target : [target];
  const names = actions.map((action) => action.name);

  assertDistinct("action", actions, (action) => action.name);

  // Checked where an action is served rather than where it is made, which a client does too.
  for (const action of actions) {
    assertOwnTags(`Action "${action.name}"`, action.errors);
    assertDistinctTags(`action "${action.name}"`, action.errors);
  }

  // Handlers are keyed by action name; a single action's handler is its own record. A
  // key no action names is refused, so a stale handler cannot outlive its action, and so
  // is an action without a handler. The result pairs each action with its handler.
  const record = (built: Built): Bound => {
    const handlers: Handlers<unknown> = Predicate.isFunction(built)
      ? isList(target)
        ? {}
        : { [target.name]: built }
      : built;

    const unknown = Object.keys(handlers).filter((key) => !names.includes(key));

    if (unknown.length > 0) throw new Error(`Unknown handlers: ${unknown.join(", ")}`);

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

  return new Implementation(actions, handlers, before);
}

/**
 * Serve some of `app`'s actions with its handlers, behind its hook, or `before` instead:
 * `share([Poll], users)` for a surface serving fewer actions, `share(actions, users,
 * trustAdmin)` for an admin CLI, `share([Poll], users, () => Effect.void)` for a public one.
 * The result shares `app`'s builder, which runs once per host build however many
 * implementations share it.
 */
export function share<
  App extends AnyImplementation,
  const T extends Extract<ActionOf<App>, Any> | ReadonlyArray<Extract<ActionOf<App>, Any>>,
>(
  target: T,
  app: App,
): Implementation<
  ActionsOf<T>,
  SharedRequests<T, App, HookOf<App>>,
  App["~buildError"],
  App["~buildContext"]
>;
export function share<
  App extends AnyImplementation,
  const T extends Extract<ActionOf<App>, Any> | ReadonlyArray<Extract<ActionOf<App>, Any>>,
  RB = never,
>(
  target: T,
  app: App,
  before: Before<ActionsOf<T>, RB>,
): Implementation<
  ActionsOf<T>,
  SharedRequests<T, App, RB>,
  App["~buildError"],
  App["~buildContext"]
>;
export function share(
  target: Target,
  app: AnyImplementation,
  before?: Before<Any, unknown>,
): Implementation<Any, {}, unknown, unknown> {
  const actions = isList(target) ? target : [target];

  assertDistinct("action", actions, (action) => action.name);

  // The types admit only `app`'s own actions; plain JavaScript may pass others.
  const unknown = actions.filter((action) => !app.actions.includes(action));

  if (unknown.length > 0) {
    throw new Error(
      `Not implemented by this implementation: ${unknown.map(({ name }) => name).join(", ")}`,
    );
  }

  return new Implementation<Any, {}, unknown, unknown>(actions, app, before);
}
