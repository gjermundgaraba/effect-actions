import { Layer } from "effect";
import type { Cause, Effect } from "effect";
import type { Stdio as StdioService } from "effect/Stdio";
import { McpServer, type McpSchema } from "effect/unstable/ai";
import type { HttpRouter } from "effect/unstable/http";
import type * as Action from "./Action.js";
import { bindTools, type ToolOptions } from "./internal/tools.js";
import {
  type AnyImplementation,
  type BuildContext,
  type BuildError,
  type RequestContext,
} from "./internal/implementation.js";

/** What every MCP transport binds around the tools it serves. */
interface SurfaceOptions<Errors extends ReadonlyArray<Action.Codec>, R> {
  /**
   * Failures the surface answers with instead of a handler: authorization, rate
   * limits. Declared on every tool of this transport, so a refusal is returned
   * as an `isError` result exactly like an action's own error.
   */
  readonly errors?: Errors;
  /**
   * Runs once per tool call, after the native server has decoded the arguments
   * and before the selected handler, with the action contract it is about to run.
   * It fails with this transport's `errors`. Its services are request-time
   * requirements, like a handler's.
   */
  readonly before?: (action: Action.Any) => Effect.Effect<void, Errors[number]["Type"], R>;
}

/** One Streamable HTTP MCP endpoint; its fields become the native server info. */
export interface Options<
  Errors extends ReadonlyArray<Action.Codec> = [],
  R = never,
> extends SurfaceOptions<Errors, R> {
  readonly name: string;
  readonly version: string;
  /** Native protocol adapters to serve; negotiation and sessions are owned by Effect. */
  readonly protocols: Parameters<typeof McpServer.layerHttp>[0]["protocols"];
  /** Route of the Streamable HTTP endpoint; no default. */
  readonly path: HttpRouter.PathInput;
  /** Browser origins accepted by the native server; passed through to `McpServer.layerHttp`. */
  readonly allowedOrigins?: ReadonlyArray<string>;
  readonly instructions?: string;
}

/** Server information for an MCP subprocess connected through standard I/O. */
export interface StdioOptions<
  Errors extends ReadonlyArray<Action.Codec> = [],
  R = never,
> extends SurfaceOptions<Errors, R> {
  readonly name: string;
  readonly version: string;
  /** Native protocol adapters to serve; negotiation is owned by Effect. */
  readonly protocols: Parameters<typeof McpServer.layerStdio>[0]["protocols"];
  readonly instructions?: string;
}

/** The native server supplies its own request context to every tool call. */
type ToolRequestContext<App, RB> = Exclude<
  RequestContext<App, "mcp"> | RB,
  McpSchema.McpRequestContext
>;

const registration = (apps: ReadonlyArray<AnyImplementation>, options: ToolOptions) => {
  const binding = bindTools(apps, "mcp", options);

  return Layer.effectDiscard(McpServer.registerToolkit(binding.toolkit)).pipe(
    Layer.provide(binding.layer),
  );
};

const server = <Out, R>(
  apps: ReadonlyArray<AnyImplementation>,
  options: ToolOptions,
  transport: Layer.Layer<Out, Cause.IllegalArgumentError, R>,
) =>
  registration(apps, options).pipe(
    Layer.provide(transport),
    // The native registry is mutable; every endpoint/subprocess gets its own one.
    Layer.fresh,
  );

/**
 * Serve MCP tools over one Streamable HTTP endpoint.
 *
 * Middleware provided around this layer has the normal HTTP lifetime. Native
 * context capture applies: never provide request-identity tags at startup.
 */
export function layerHttp<
  const Apps extends ReadonlyArray<AnyImplementation>,
  const Errors extends ReadonlyArray<Action.Codec> = [],
  RB = never,
>(
  apps: readonly [...Apps],
  options: Options<Errors, RB>,
): Layer.Layer<
  never,
  BuildError<Apps[number], "mcp"> | Cause.IllegalArgumentError,
  | BuildContext<Apps[number], "mcp">
  | HttpRouter.HttpRouter
  | HttpRouter.Request.From<"Requires", ToolRequestContext<Apps[number], RB>>
>;
export function layerHttp(
  apps: ReadonlyArray<AnyImplementation>,
  options: Options<ReadonlyArray<Action.Codec>, unknown>,
) {
  return server(
    apps,
    { errors: options.errors, before: options.before },
    McpServer.layerHttp({
      name: options.name,
      version: options.version,
      instructions: options.instructions,
      path: options.path,
      protocols: options.protocols,
      allowedOrigins: options.allowedOrigins,
    }),
  );
}

/**
 * Serve MCP tools through newline-delimited JSON-RPC on standard I/O.
 *
 * The host supplies the `Stdio` service. Arguments are tool input only and
 * never establish request identity or authority.
 */
export function layerStdio<
  const Apps extends ReadonlyArray<AnyImplementation>,
  const Errors extends ReadonlyArray<Action.Codec> = [],
  RB = never,
>(
  apps: readonly [...Apps],
  options: StdioOptions<Errors, RB>,
): Layer.Layer<
  never,
  BuildError<Apps[number], "mcp"> | Cause.IllegalArgumentError,
  BuildContext<Apps[number], "mcp"> | StdioService | ToolRequestContext<Apps[number], RB>
>;
export function layerStdio(
  apps: ReadonlyArray<AnyImplementation>,
  options: StdioOptions<ReadonlyArray<Action.Codec>, unknown>,
) {
  return server(
    apps,
    { errors: options.errors, before: options.before },
    McpServer.layerStdio(options),
  );
}
