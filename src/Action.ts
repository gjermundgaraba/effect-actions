import { Effect, Predicate, Schema } from "effect";
import type { Scope } from "effect";
import { assertDistinct, assertName } from "./internal/actions.js";
import {
  type Before,
  type ErasedHandler,
  type HandlerContext,
  type Handlers,
  Implementation,
} from "./internal/implementation.js";

/** An action bound to its handler; opaque, see `implement`. */
export type { Implementation } from "./internal/implementation.js";

/** Any service-free schema. Only handlers may require services. */
type Codec = Schema.Codec<unknown, unknown, never, never>;

/** Struct fields, accepted wherever a struct schema is: `{ name: Schema.String }`. */
type Fields = { readonly [key: string]: Codec };

/** The schema a `Codec | Fields` option stands for. */
type CodecOf<S extends Codec | Fields> = S extends Codec
  ? S
  : S extends Schema.Struct.Fields
    ? Extract<Schema.Struct<S>, Codec>
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
interface Hints {
  /** `destructiveHint`, a write's only; defaults to `true`. A read is never destructive. */
  readonly destructive?: boolean;
  /** `idempotentHint`; defaults to `false`. */
  readonly idempotent?: boolean;
  /** `openWorldHint`; defaults to `true`. */
  readonly openWorld?: boolean;
}

/** The refusals every surface answers with; see `internal/errors`. */
export { Forbidden, InvalidInput, type Refusal, Unauthenticated } from "./internal/errors.js";

/** What `make` needs to define an action. */
interface Options {
  readonly description: string;
  /** A schema or struct fields. Omit for an action without arguments. */
  readonly input?: Codec | Fields;
  /** A schema or struct fields. Omit for an action that returns nothing: `Schema.Void`. */
  readonly success?: Codec | Fields;
  /** One schema per declared failure; each keeps its own HTTP status annotation. Defaults to none. */
  readonly errors?: ReadonlyArray<Codec>;
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

/** What an option `K` that may be undefined must be instead: nothing is, and its error names the rule. */
interface MaybeAbsent<K extends string> {
  readonly "Give this option or omit it: a value that may be undefined is neither": K;
}

/**
 * The options of `O` whose absence changes a type, refused when they may be absent: its
 * default would then hold at run time while the type says otherwise. Branch around the
 * call instead.
 */
type Present<O, K extends string> = {
  readonly [
    P in Extract<keyof O, K> as {} extends Pick<O, P> ? P : undefined extends O[P] ? P : never
  ]: MaybeAbsent<P & string>;
};

/**
 * No key beyond `Known`, so a misspelled option is refused rather than ignored. Checked
 * after inference, as `Exact` is.
 */
type Known<O, Keys> = { readonly [K in Exclude<keyof O, keyof Keys>]: never };

/**
 * The rules `make` checks beyond `Options`: every option known and present, and a read
 * never destructive. Options that fail `Options` itself infer as `Options`, whose error the
 * compiler already reports, so they are not checked again.
 */
type Rules<O> = Options extends O
  ? unknown
  : Known<O, Options> &
      Present<O, "input" | "success" | "errors"> &
      (O extends { readonly access: "read" }
        ? { readonly hints?: { readonly destructive?: never } }
        : unknown);

/**
 * Option `K` of `O` as given, or `Default` wherever it may be omitted, as at run time, for
 * each member of a union of options: only options widened to `Options` itself, which `Rules`
 * leaves unchecked, may be both in one member.
 */
type OptionOf<O, K extends keyof Options, Default> = O extends unknown
  ?
      | (K extends keyof O ? Exclude<O[K], undefined> : never)
      | ({} extends Pick<O, K & keyof O> ? Default : never)
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
  Output extends Codec,
  Errors extends ReadonlyArray<Codec>,
  Acc extends Access = Access,
> {
  readonly name: Name;
  readonly description: string;
  readonly input: Input;
  readonly success: Output;
  readonly errors: Errors;
  // Declared, never defaulted, so a rule that switches on it reads a literal
  // rather than the runtime values the hints are.
  readonly access: Acc;
  readonly hints: Required<Hints>;
}

/** Any action, with its schemas erased. */
export type Any = Action<string, Codec, Codec, ReadonlyArray<Codec>>;

/** Receives decoded input; may fail only with the declared errors. */
export type Handler<A extends Any, R = never> = (
  input: A["input"]["Type"],
) => Effect.Effect<A["success"]["Type"], A["errors"][number]["Type"], R>;

/** An empty object schema that also produces the object root MCP requires. */
const NoInput = Schema.Record(Schema.String, Schema.Never);

const codecOf = (schema: Codec | Fields): Codec =>
  Schema.isSchema(schema) ? schema : Schema.Struct(schema);

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
    input: options.input === undefined ? NoInput : codecOf(options.input),
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
 * Each action's per-request requirements, by name: its entry of `H`, or `H` itself, and
 * the hook's `RB`.
 */
type RequestsOf<T extends Target, H, RB> = {
  readonly [A in ActionsOf<T> as A["name"]]:
    | HandlerContext<T extends ReadonlyArray<Any> ? H[A["name"] & keyof H] : H>
    | RB;
};

/** The names a handlers record may have: none for a single action's handler. */
type Names<T extends Target> = T extends ReadonlyArray<Any> ? T[number]["name"] : never;

/**
 * A handlers record with no key beyond its actions' names. `H` itself stays the inferred
 * parameter, so handlers are contextually typed and a generic handler such as
 * `Effect.succeed` is still inferred; the check does not take part in inference.
 */
type Exact<T extends Target, H> = H &
  NoInfer<{ readonly [K in Exclude<keyof H, Names<T>>]: never } & ReturnsNothing<T, H>>;

/** What a handler succeeds with. */
type SuccessOf<F> = F extends (...args: any) => Effect.Effect<infer S, any, any> ? S : never;

/**
 * Whether `F` returns data its action cannot: `Effect<A>` is assignable to `Effect<void>`,
 * so without this check a void action's handler could return a value its encoding drops.
 */
type Drops<A extends Any, F> = [A["success"]["Type"]] extends [void]
  ? [SuccessOf<F>] extends [void]
    ? false
    : true
  : false;

/** What a handler that drops its value lacks, so the error names the rule. */
interface Discarding {
  readonly "Its action returns nothing: declare a success schema to return data": never;
}

/** A handler of a void action must return nothing. */
type ReturnsNothing<T extends Target, H> =
  T extends ReadonlyArray<Any>
    ? {
        readonly [
          A in T[number] as Drops<A, H[A["name"] & keyof H]> extends true ? A["name"] : never
        ]: Discarding;
      }
    : T extends Any
      ? Drops<T, H> extends true
        ? Discarding
        : unknown
      : unknown;

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

  // Handlers are keyed by action name; a single action's handler is its own record. A
  // key no action names is refused, so a stale handler cannot outlive its action, and so
  // is an action without a handler.
  const record = (built: Built): Handlers<unknown> => {
    const handlers: Handlers<unknown> = Predicate.isFunction(built)
      ? isList(target)
        ? {}
        : { [target.name]: built }
      : built;

    const unknown = Object.keys(handlers).filter((key) => !names.includes(key));

    if (unknown.length > 0) throw new Error(`Unknown handlers: ${unknown.join(", ")}`);

    const missing = names.filter(
      (name) => !Object.hasOwn(handlers, name) || !Predicate.isFunction(handlers[name]),
    );

    if (missing.length > 0) throw new Error(`Missing handlers: ${missing.join(", ")}`);

    return handlers;
  };

  // Plain handlers are checked here; a builder's record when it is built.
  const handlers = Effect.isEffect(build)
    ? Effect.map(build, record)
    : Effect.succeed(record(build));

  return new Implementation(actions, handlers, before);
}
