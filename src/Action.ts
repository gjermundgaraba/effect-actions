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
export type CodecOf<S extends Codec | Fields> = S extends Codec
  ? S
  : S extends Schema.Struct.Fields
    ? Extract<Schema.Struct<S>, Codec>
    : never;

/**
 * What an action does to the resource it serves: `"read"` observes, `"write"`
 * may change it. Authorization metadata, not an MCP hint.
 */
export type Access = "read" | "write";

/** MCP tool metadata; every field has a default derived from the action. */
export interface McpOptions {
  /** Tool name; defaults to the action name. Must match `^[A-Za-z0-9_-]{1,128}$`. */
  readonly name?: string;
  /** `readOnlyHint`; defaults to `access === "read"`. */
  readonly readOnly?: boolean;
  /** `destructiveHint`; defaults to `!readOnly`, as the MCP spec only defines it for writes. */
  readonly destructive?: boolean;
  /** `idempotentHint`; defaults to `false`. */
  readonly idempotent?: boolean;
  /** `openWorldHint`; defaults to `true`. */
  readonly openWorld?: boolean;
}

type ResolvedMcp<
  Name extends string,
  Mcp extends false | McpOptions | undefined,
> = Mcp extends false
  ? false
  : {
      readonly name: Mcp extends McpOptions
        ? "name" extends keyof Mcp
          ? Extract<Mcp["name"], string> extends never
            ? Name
            : Extract<Mcp["name"], string> | (undefined extends Mcp["name"] ? Name : never)
          : Name
        : Name;
      // Names and the `false` exclusion are contract-level type information.
      // Hints are runtime metadata with defaults, so broad option variables
      // must not claim a literal value that their runtime value may not have.
      readonly readOnly: boolean;
      readonly destructive: boolean;
      readonly idempotent: boolean;
      readonly openWorld: boolean;
    };

/** What `make` needs to define an action. */
export interface Options<
  Input extends Codec | Fields,
  Output extends Codec | Fields,
  Errors extends ReadonlyArray<Codec>,
  Acc extends Access = Access,
  Mcp extends false | McpOptions | undefined = McpOptions | undefined,
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
  /** `false` hides the action from MCP; otherwise tool metadata. */
  readonly mcp?: Mcp;
}

/** A pure contract: schemas and transport metadata. Handlers are bound by `implement`. */
export interface Action<
  Name extends string,
  Input extends Codec,
  Output extends Codec,
  Errors extends ReadonlyArray<Codec>,
  Acc extends Access = Access,
  Mcp extends false | McpOptions | undefined = McpOptions | undefined,
> {
  readonly name: Name;
  readonly description: string;
  readonly input: Input;
  readonly success: Output;
  readonly errors: Errors;
  // Declared, never defaulted, so a rule that switches on it reads a literal
  // rather than the runtime union the MCP hints are.
  readonly access: Acc;
  readonly mcp: ResolvedMcp<Name, Mcp>;
}

/** Any action, with its schemas erased. */
export type Any =
  | Action<string, Codec, Codec, ReadonlyArray<Codec>, Access, false>
  | Action<string, Codec, Codec, ReadonlyArray<Codec>, Access, McpOptions>
  | Action<string, Codec, Codec, ReadonlyArray<Codec>, Access, undefined>;

/** Receives decoded input; may fail only with the declared errors. */
export type Handler<A extends Any, R = never> = (
  input: A["input"]["Type"],
) => Effect.Effect<A["success"]["Type"], A["errors"][number]["Type"], R>;

/** An empty object schema that also produces the object root MCP requires. */
const NoInput = Schema.Record(Schema.String, Schema.Never);

type AnyOptions = Options<
  Codec | Fields,
  Codec | Fields,
  ReadonlyArray<Codec>,
  Access,
  false | McpOptions | undefined
>;

/**
 * The `mcp` option `make` received. Only a required literal `false` hides the action:
 * options that may carry something else, such as a conditional spread, `false | undefined`
 * or a broadly typed variable, may serve it, so its requirements are kept.
 */
type McpOf<O extends AnyOptions> = [O] extends [{ readonly mcp: false }]
  ? false
  : O extends { readonly mcp: infer Mcp extends false | McpOptions | undefined }
    ? Mcp
    : "mcp" extends keyof O
      ? O["mcp"] | undefined
      : undefined;

const codecOf = (schema: Codec | Fields): Codec =>
  Schema.isSchema(schema) ? schema : Schema.Struct(schema);

/**
 * Define an action contract. Names are `[A-Za-z0-9_-]+`, other than `then`.
 * `mcp: false` hides one from MCP and native Toolkits.
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
  O["access"],
  McpOf<O>
>;
export function make(name: string, options: AnyOptions): Any {
  assertName("action name", name);

  const { access } = options;

  // The type is the only thing stopping a third value, and a plain-JavaScript
  // caller has none: an unclassified action must not reach a hook that reads it.
  if (access !== "read" && access !== "write") throw new Error(`Invalid access: ${String(access)}`);

  // One contract states the fact once: a read action is a read-only tool unless
  // the contract says otherwise.
  const readOnly = options.mcp === false ? false : (options.mcp?.readOnly ?? access === "read");

  const mcp =
    options.mcp === false
      ? false
      : {
          name: options.mcp?.name ?? name,
          readOnly,
          destructive: options.mcp?.destructive ?? !readOnly,
          idempotent: options.mcp?.idempotent ?? false,
          openWorld: options.mcp?.openWorld ?? true,
        };

  if (mcp !== false && mcp.name.length > 128) {
    throw new Error(`Invalid MCP name: ${mcp.name}`);
  }

  if (mcp !== false) assertName("MCP name", mcp.name);

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
export type Target = Any | ReadonlyArray<Any>;

/** The handler of one action, or a record of handlers keyed by action name. */
export type HandlersFor<T extends Target> =
  T extends ReadonlyArray<Any>
    ? { readonly [A in T[number] as A["name"]]: Handler<A, any> }
    : T extends Any
      ? Handler<T, any>
      : never;

/** The handler `H` binds to `A`: `H` itself for one action, else its entry for `A`. */
type HandlerFor<T extends Target, H, A extends Any> =
  T extends ReadonlyArray<Any> ? H[A["name"] & keyof H] : H;

type ImplementationOf<T extends Target, H, EX, RX, A> = A extends Any
  ? Implementation<A, HandlerContext<HandlerFor<T, H, A>>, EX, RX>
  : never;

/**
 * What `implement` returns: one `Implementation` per action, each carrying its own
 * handler's request requirements and the shared builder's failures and services.
 */
export type ImplementationFor<T extends Target, H, EX, RX> = ReadonlyArray<
  ImplementationOf<T, H, EX, RX, T extends ReadonlyArray<Any> ? T[number] : T>
>;

/** A handlers record with no key beyond its actions' names. */
type Exact<T extends Target, H> =
  T extends ReadonlyArray<Any>
    ? H & { readonly [K in Exclude<keyof H, T[number]["name"]>]: never }
    : H;

/** What `implement` receives, erased: one handler, or a record of them. */
type Built = Handlers<unknown> | ErasedHandler<unknown>;

const isList = (target: Target): target is ReadonlyArray<Any> => Array.isArray(target);

/**
 * Bind handlers to contracts. Pass one action and its handler, or a list of actions and
 * a record of handlers keyed by action name. Either may instead be an Effect that builds
 * them: its services are resolved once per adapter layer that serves the result, and are
 * startup requirements, while services a handler yields are per-request requirements.
 * Returns one implementation per action, as a list; lists combine by spreading.
 */
export function implement<const T extends Target, H extends HandlersFor<T>, EX = never, RX = never>(
  target: T,
  build: Exact<T, H> | Effect.Effect<Exact<T, H>, EX, RX>,
): ImplementationFor<T, H, NoInfer<EX>, NoInfer<Exclude<RX, Scope.Scope>>>;
export function implement(
  target: Target,
  build: Built | Effect.Effect<Built, unknown, unknown>,
): ReadonlyArray<Implementation<Any, unknown, unknown, unknown>> {
  const actions = isList(target) ? target : [target];
  const names = actions.map((action) => action.name);

  assertDistinct("action", names);

  // Handlers are keyed by action name; a single action's handler is its own record. A
  // key no action names is refused, so a stale handler cannot outlive its action. A
  // missing handler is refused where it is looked up, when an adapter builds.
  const record = (built: Built): Handlers<unknown> => {
    if (Predicate.isFunction(built)) return isList(target) ? {} : { [target.name]: built };

    const unknown = Object.keys(built).filter((key) => !names.includes(key));

    if (unknown.length > 0) throw new Error(`Unknown handlers: ${unknown.join(", ")}`);

    return built;
  };

  // Both forms are checked when an adapter builds them, never here.
  const handlers = Effect.map(Effect.isEffect(build) ? build : Effect.succeed(build), record);

  return actions.map((action) => Implementation.make(action, handlers));
}
