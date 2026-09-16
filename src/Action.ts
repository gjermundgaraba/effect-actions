import { Schema } from "effect";
import type { Effect } from "effect";

// Schemas must be service-free. Handler dependencies are unrestricted.
export type Codec = Schema.Codec<unknown, unknown, never, never>;

/** Failed request decoding or successful-result encoding, independent of transport terminology. */
export interface SchemaFailure {
  readonly phase: "input" | "output";
  /** May contain sensitive values. Do not reflect it in public error messages. */
  readonly cause: Schema.SchemaError;
}

/** Pure application-owned mapping, shared by the HTTP and MCP adapters. */
export interface SchemaErrorPolicy<Errors extends ReadonlyArray<Codec>> {
  readonly errors: Errors;
  readonly map: (failure: SchemaFailure) => NoInfer<Errors[number]["Type"]>;
}

export interface McpOptions {
  readonly name?: string;
  readonly readOnly?: boolean;
  /** Defaults to `!readOnly`; the MCP spec only defines it for non-read-only tools. */
  readonly destructive?: boolean;
}

export interface Options<
  Input extends Codec,
  Output extends Codec,
  Errors extends ReadonlyArray<Codec>,
  Http extends boolean = boolean,
> {
  readonly description: string;
  /** Defaults to `NoInput`. */
  readonly input?: Input;
  readonly success: Output;
  /** One schema per declared failure; each keeps its own HTTP status annotation. Defaults to none. */
  readonly error?: Errors;
  readonly http?: Http;
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

export type Any = Action<string, Codec, Codec, ReadonlyArray<Codec>>;

/** Receives decoded input; may fail only with the declared errors. */
export type Handler<A extends Any, R = never> = (
  input: A["input"]["Type"],
) => Effect.Effect<A["success"]["Type"], A["errors"][number]["Type"], R>;

/** An empty object schema that also produces the object root MCP requires. */
export const NoInput = Schema.Record(Schema.String, Schema.Never);

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
  if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(name)) throw new Error(`Invalid action name: ${name}`);

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
    errors: options.error ?? [],
    http: options.http !== false,
    mcp,
  };
}
