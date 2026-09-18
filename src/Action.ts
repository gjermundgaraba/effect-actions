import { Schema } from "effect";
import type { Effect } from "effect";
import { assertName } from "./internal/actions.js";

/** Any service-free schema. Only handlers may require services. */
export type Codec = Schema.Codec<unknown, unknown, never, never>;

/** Failed request decoding or successful-result encoding, independent of transport terminology. */
export interface SchemaFailure {
  readonly phase: "input" | "output";
  /** May contain sensitive values. Do not reflect it in public error messages. */
  readonly cause: Schema.SchemaError;
}

/** Pure application-owned mapping, set on a group and applied by the HTTP adapter. */
export interface SchemaErrorPolicy<Errors extends ReadonlyArray<Codec>> {
  readonly errors: Errors;
  readonly map: (failure: SchemaFailure) => NoInfer<Errors[number]["Type"]>;
}

/** MCP tool metadata; every field has a default derived from the action. */
export interface McpOptions {
  /** Tool name; defaults to the action name. Must match `^[A-Za-z0-9_-]{1,128}$`. */
  readonly name?: string;
  /** `readOnlyHint`; defaults to `false`. */
  readonly readOnly?: boolean;
  /** `destructiveHint`; defaults to `!readOnly`, as the MCP spec only defines it for writes. */
  readonly destructive?: boolean;
}

/** What `make` needs to define an action. */
export interface Options<
  Input extends Codec,
  Output extends Codec,
  Errors extends ReadonlyArray<Codec>,
  Http extends boolean = boolean,
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
  readonly mcp?: false | McpOptions;
}

/** A pure contract: schemas and transport metadata. Implementations are bound by `ActionGroup.implement`. */
export interface Action<
  Name extends string,
  Input extends Codec,
  Output extends Codec,
  Errors extends ReadonlyArray<Codec>,
  Http extends boolean = boolean,
> {
  readonly name: Name;
  readonly description: string;
  readonly input: Input;
  readonly success: Output;
  readonly errors: Errors;
  readonly http: Http;
  readonly mcp:
    | false
    | {
        readonly name: string;
        readonly readOnly: boolean;
        readonly destructive: boolean;
      };
}

/** Any action, with its schemas erased. */
export type Any = Action<string, Codec, Codec, ReadonlyArray<Codec>>;

/** Receives decoded input; may fail only with the declared errors. */
export type Handler<A extends Any, R = never> = (
  input: A["input"]["Type"],
) => Effect.Effect<A["success"]["Type"], A["errors"][number]["Type"], R>;

/** An empty object schema that also produces the object root MCP requires. */
const NoInput = Schema.Record(Schema.String, Schema.Never);

/**
 * Define an action contract. Names are `[A-Za-z][A-Za-z0-9_-]*`, other than `then`.
 * An action exposed on neither transport is rejected here, at definition time.
 */
export function make<
  const Name extends string,
  Input extends Codec = typeof NoInput,
  Output extends Codec = never,
  const Errors extends ReadonlyArray<Codec> = [],
  const Http extends boolean = true,
>(
  name: Name,
  options: Options<Input, Output, Errors, Http>,
): Action<Name, Input, Output, Errors, Http>;
export function make(name: string, options: Options<Codec, Codec, ReadonlyArray<Codec>>): Any {
  assertName("action name", name);

  if (options.http === false && options.mcp === false) {
    throw new Error(`Action ${name} is exposed on no transport`);
  }

  const readOnly = options.mcp === false ? false : (options.mcp?.readOnly ?? false);

  const mcp =
    options.mcp === false
      ? false
      : {
          name: options.mcp?.name ?? name,
          readOnly,
          destructive: options.mcp?.destructive ?? !readOnly,
        };

  if (mcp !== false && !/^[A-Za-z0-9_-]{1,128}$/.test(mcp.name)) {
    throw new Error(`Invalid MCP name: ${mcp.name}`);
  }

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
