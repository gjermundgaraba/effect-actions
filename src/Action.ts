import { Effect, Predicate, Schema } from "effect";
import type { Scope } from "effect";
import { assertDistinct, assertName } from "./internal/actions.js";
import {
  type ErasedHandler,
  type HandlerContext,
  type Handlers,
  Implementation,
} from "./internal/implementation.js";

/** An action bound to its handler; opaque, see `implement`. */
export type { Implementation } from "./internal/implementation.js";

/** Any service-free schema. Only handlers may require services. */
export type Codec = Schema.Codec<unknown, unknown, never, never>;

/** Struct fields, accepted wherever a struct schema is: `{ name: Schema.String }`. */
export type Fields = { readonly [key: string]: Codec };

/** The schema a `Codec | Fields` option stands for. */
type CodecOf<S extends Codec | Fields> = S extends Codec
  ? S
  : S extends Schema.Struct.Fields
    ? Extract<Schema.Struct<S>, Codec>
    : never;

/**
 * What an action does to the resource it serves: `"read"` observes, `"write"`
 * may change it. Authorization metadata, not an MCP hint.
 */
export type Access = "read" | "write";

/** MCP tool hints; every field has a default derived from the action. */
export interface McpOptions {
  /** `readOnlyHint`; defaults to `access === "read"`. */
  readonly readOnly?: boolean;
  /** `destructiveHint`; defaults to `!readOnly`, as the MCP spec only defines it for writes. */
  readonly destructive?: boolean;
  /** `idempotentHint`; defaults to `false`. */
  readonly idempotent?: boolean;
  /** `openWorldHint`; defaults to `true`. */
  readonly openWorld?: boolean;
}

/** What `make` needs to define an action. */
export interface Options<
  Input extends Codec | Fields,
  Output extends Codec | Fields,
  Errors extends ReadonlyArray<Codec>,
  Acc extends Access = Access,
> {
  readonly description: string;
  /** A schema or struct fields. Omit for an action without arguments. */
  readonly input?: Input;
  /** A schema or struct fields. */
  readonly success: Output;
  /** One schema per declared failure; each keeps its own HTTP status annotation. Defaults to none. */
  readonly errors?: Errors;
  /**
   * What the action does to its resource. Required: an action nobody classified
   * is the one a reviewer must check. Read by a surface's `before` hook; the
   * library itself authorizes nothing.
   */
  readonly access: Acc;
  /** MCP tool hints. The tool is named after the action. */
  readonly mcp?: McpOptions;
}

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
  // rather than the runtime values the MCP hints are.
  readonly access: Acc;
  readonly mcp: Required<McpOptions>;
}

/** Any action, with its schemas erased. */
export type Any = Action<string, Codec, Codec, ReadonlyArray<Codec>>;

/** Receives decoded input; may fail only with the declared errors. */
export type Handler<A extends Any, R = never> = (
  input: A["input"]["Type"],
) => Effect.Effect<A["success"]["Type"], A["errors"][number]["Type"], R>;

/** An empty object schema that also produces the object root MCP requires. */
const NoInput = Schema.Record(Schema.String, Schema.Never);

type AnyOptions = Options<Codec | Fields, Codec | Fields, ReadonlyArray<Codec>>;

const codecOf = (schema: Codec | Fields): Codec =>
  Schema.isSchema(schema) ? schema : Schema.Struct(schema);

/**
 * Define an action contract. Names are `[A-Za-z0-9_-]{1,128}`, other than `then`: the name
 * is also the route segment, the client method and the MCP tool name.
 */
export function make<const Name extends string, const O extends AnyOptions>(
  name: Name,
  // A key `Options` does not declare, such as a stale or misspelled one, is refused.
  options: O & { readonly [K in Exclude<keyof O, keyof AnyOptions>]: never },
): Action<
  Name,
  "input" extends keyof O ? CodecOf<Exclude<O["input"], undefined>> : typeof NoInput,
  CodecOf<O["success"]>,
  "errors" extends keyof O ? Exclude<O["errors"], undefined> : [],
  O["access"]
>;
export function make(name: string, options: AnyOptions): Any {
  assertName("action name", name);

  const { access } = options;

  // The type is the only thing stopping a third value, and a plain-JavaScript
  // caller has none: an unclassified action must not reach a hook that reads it.
  if (access !== "read" && access !== "write") throw new Error(`Invalid access: ${String(access)}`);

  // One contract states the fact once: a read action is a read-only tool unless
  // the contract says otherwise.
  const readOnly = options.mcp?.readOnly ?? access === "read";

  const mcp = {
    readOnly,
    destructive: options.mcp?.destructive ?? !readOnly,
    idempotent: options.mcp?.idempotent ?? false,
    openWorld: options.mcp?.openWorld ?? true,
  };

  return {
    name,
    description: options.description,
    input: options.input === undefined ? NoInput : codecOf(options.input),
    success: codecOf(options.success),
    errors: options.errors ?? [],
    access,
    mcp,
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

/** Each action's per-request requirements, by name: its entry of `H`, or `H` itself. */
type RequestsOf<T extends Target, H> = {
  readonly [A in ActionsOf<T> as A["name"]]: HandlerContext<
    T extends ReadonlyArray<Any> ? H[A["name"] & keyof H] : H
  >;
};

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
 */
export function implement<const T extends Target, H extends HandlersFor<T>, EX = never, RX = never>(
  target: T,
  build: Exact<T, H> | Effect.Effect<Exact<T, H>, EX, RX>,
): Implementation<ActionsOf<T>, RequestsOf<T, H>, NoInfer<EX>, NoInfer<Exclude<RX, Scope.Scope>>>;
export function implement(
  target: Target,
  build: Built | Effect.Effect<Built, unknown, unknown>,
): Implementation<Any, {}, unknown, unknown> {
  const actions = isList(target) ? target : [target];
  const names = actions.map((action) => action.name);

  assertDistinct("action", names);

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

  return new Implementation(actions, handlers);
}
