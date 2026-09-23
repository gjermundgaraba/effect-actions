import { Schema } from "effect";
import type { Effect } from "effect";
import { assertName } from "./internal/actions.js";

/** Any service-free schema. Only handlers may require services. */
export type Codec = Schema.Codec<unknown, unknown, never, never>;

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
  Input extends Codec,
  Output extends Codec,
  Errors extends ReadonlyArray<Codec>,
  Acc extends Access = Access,
  Http extends false = never,
  Mcp extends false | McpOptions | undefined = McpOptions | undefined,
> {
  readonly description: string;
  /** Omit for an action without arguments. */
  readonly input?: Input;
  readonly success: Output;
  /** One schema per declared failure; each keeps its own HTTP status annotation. Defaults to none. */
  readonly errors?: Errors;
  /**
   * What the action does to its resource. Required: an action nobody classified
   * is the one a reviewer must check. Read by a surface's `before` hook; the
   * library itself authorizes nothing.
   */
  readonly access: Acc;
  /**
   * `false` hides the action from HTTP routes and clients; omitted, it is served. `Http`
   * is `never` unless the options hide the action, so options typed without it cannot
   * carry `false`.
   */
  readonly http?: Http;
  /** `false` hides the action from MCP; otherwise tool metadata. */
  readonly mcp?: Mcp;
}

/** A pure contract: schemas and transport metadata. Implementations are bound by `ActionGroup.implement`. */
export interface Action<
  Name extends string,
  Input extends Codec,
  Output extends Codec,
  Errors extends ReadonlyArray<Codec>,
  Acc extends Access = Access,
  Http extends boolean = boolean,
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
  /** Whether HTTP serves the action; a literal from `make`, so the served set is exact. */
  readonly http: Http;
  readonly mcp: ResolvedMcp<Name, Mcp>;
}

/** Any action, with its schemas erased. */
export type Any =
  | Action<string, Codec, Codec, ReadonlyArray<Codec>, Access, boolean, false>
  | Action<string, Codec, Codec, ReadonlyArray<Codec>, Access, boolean, McpOptions>
  | Action<string, Codec, Codec, ReadonlyArray<Codec>, Access, boolean, undefined>;

/** Receives decoded input; may fail only with the declared errors. */
export type Handler<A extends Any, R = never> = (
  input: A["input"]["Type"],
) => Effect.Effect<A["success"]["Type"], A["errors"][number]["Type"], R>;

/** An empty object schema that also produces the object root MCP requires. */
const NoInput = Schema.Record(Schema.String, Schema.Never);

/**
 * Define an action contract. Names are `[A-Za-z0-9_-]+`, other than `then`.
 * Actions can be local-only by setting both transports to `false`.
 *
 * Two overloads decide HTTP: `http: false`, always present, hides the action; `http`
 * absent serves it. Options that may or may not hide it, such as a conditional spread or
 * `false | undefined`, match neither, so the action's `http` type is never a guess.
 */
export function make<
  const Name extends string,
  Input extends Codec = typeof NoInput,
  Output extends Codec = never,
  const Errors extends ReadonlyArray<Codec> = [],
  const Acc extends Access = Access,
  const Mcp extends false | McpOptions | undefined = undefined,
>(
  name: Name,
  options: Options<Input, Output, Errors, Acc, false, Mcp> & { readonly http: false },
): Action<Name, Input, Output, Errors, Acc, false, Mcp>;
export function make<
  const Name extends string,
  Input extends Codec = typeof NoInput,
  Output extends Codec = never,
  const Errors extends ReadonlyArray<Codec> = [],
  const Acc extends Access = Access,
  const Mcp extends false | McpOptions | undefined = undefined,
>(
  name: Name,
  options: Options<Input, Output, Errors, Acc, never, Mcp>,
): Action<Name, Input, Output, Errors, Acc, true, Mcp>;
export function make(
  name: string,
  options: Options<
    Codec,
    Codec,
    ReadonlyArray<Codec>,
    Access,
    false,
    false | McpOptions | undefined
  >,
): Any {
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
    input: options.input ?? NoInput,
    success: options.success,
    errors: options.errors ?? [],
    access,
    http: options.http !== false,
    mcp,
  };
}
