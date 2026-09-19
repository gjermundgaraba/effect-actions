import { Schema } from "effect";
import type { Effect } from "effect";
import { assertName } from "./internal/actions.js";

/** Any service-free schema. Only handlers may require services. */
export type Codec = Schema.Codec<unknown, unknown, never, never>;

/** MCP tool metadata; every field has a default derived from the action. */
export interface McpOptions {
  /** Tool name; defaults to the action name. Must match `^[A-Za-z0-9_-]{1,128}$`. */
  readonly name?: string;
  /** `readOnlyHint`; defaults to `false`. */
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
  Http extends boolean = boolean,
  Mcp extends false | McpOptions | undefined = McpOptions | undefined,
> {
  readonly description: string;
  /** Omit for an action without arguments. */
  readonly input?: Input;
  readonly success: Output;
  /** One schema per declared failure; each keeps its own HTTP status annotation. Defaults to none. */
  readonly errors?: Errors;
  /** `false` hides the action from HTTP routes and clients. */
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
  Http extends boolean = boolean,
  Mcp extends false | McpOptions | undefined = McpOptions | undefined,
> {
  readonly name: Name;
  readonly description: string;
  readonly input: Input;
  readonly success: Output;
  readonly errors: Errors;
  readonly http: Http;
  readonly mcp: ResolvedMcp<Name, Mcp>;
}

/** Any action, with its schemas erased. */
export type Any =
  | Action<string, Codec, Codec, ReadonlyArray<Codec>, boolean, false>
  | Action<string, Codec, Codec, ReadonlyArray<Codec>, boolean, McpOptions>
  | Action<string, Codec, Codec, ReadonlyArray<Codec>, boolean, undefined>;

/** Receives decoded input; may fail only with the declared errors. */
export type Handler<A extends Any, R = never> = (
  input: A["input"]["Type"],
) => Effect.Effect<A["success"]["Type"], A["errors"][number]["Type"], R>;

/** An empty object schema that also produces the object root MCP requires. */
const NoInput = Schema.Record(Schema.String, Schema.Never);

/**
 * Define an action contract. Names are `[A-Za-z0-9_-]+`, other than `then`.
 * Actions can be local-only by setting both transports to `false`.
 */
export function make<
  const Name extends string,
  Input extends Codec = typeof NoInput,
  Output extends Codec = never,
  const Errors extends ReadonlyArray<Codec> = [],
  const Http extends boolean = true,
  const Mcp extends false | McpOptions | undefined = undefined,
>(
  name: Name,
  options: Options<Input, Output, Errors, Http, Mcp>,
): Action<Name, Input, Output, Errors, Http, Mcp>;
export function make(
  name: string,
  options: Options<Codec, Codec, ReadonlyArray<Codec>, boolean, false | McpOptions | undefined>,
): Any {
  assertName("action name", name);

  const readOnly = options.mcp === false ? false : (options.mcp?.readOnly ?? false);

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
    http: options.http !== false,
    mcp,
  };
}
