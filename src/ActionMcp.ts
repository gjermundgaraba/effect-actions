import { Layer } from "effect";
import type { Cause } from "effect";
import type { Stdio as StdioService } from "effect/Stdio";
import { McpServer, type McpSchema } from "effect/unstable/ai";
import type { HttpRouter } from "effect/unstable/http";
import { bindTools } from "./internal/tools.js";
import {
  type AnyImplementation,
  type BuildContext,
  type BuildError,
  type RequestContext,
} from "./internal/implementation.js";

/** One Streamable HTTP MCP endpoint; its fields become the native server info. */
export interface Options {
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
export interface StdioOptions {
  readonly name: string;
  readonly version: string;
  /** Native protocol adapters to serve; negotiation is owned by Effect. */
  readonly protocols: Parameters<typeof McpServer.layerStdio>[0]["protocols"];
  readonly instructions?: string;
}

/** The native server supplies its own request context to every tool call. */
type ToolRequestContext<App> = Exclude<RequestContext<App>, McpSchema.McpRequestContext>;

const registration = (apps: ReadonlyArray<AnyImplementation>) => {
  const binding = bindTools(apps, "mcp");

  return Layer.effectDiscard(McpServer.registerToolkit(binding.toolkit)).pipe(
    Layer.provide(binding.layer),
  );
};

const server = <Out, R>(
  apps: ReadonlyArray<AnyImplementation>,
  transport: Layer.Layer<Out, Cause.IllegalArgumentError, R>,
) =>
  registration(apps).pipe(
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
export function layerHttp<const Apps extends ReadonlyArray<AnyImplementation>>(
  options: Options,
  ...apps: Apps
): Layer.Layer<
  never,
  BuildError<Apps[number]> | Cause.IllegalArgumentError,
  | BuildContext<Apps[number]>
  | HttpRouter.HttpRouter
  | HttpRouter.Request.From<"Requires", ToolRequestContext<Apps[number]>>
>;
export function layerHttp(options: Options, ...apps: ReadonlyArray<AnyImplementation>) {
  return server(
    apps,
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
export function layerStdio<const Apps extends ReadonlyArray<AnyImplementation>>(
  options: StdioOptions,
  ...apps: Apps
): Layer.Layer<
  never,
  BuildError<Apps[number]> | Cause.IllegalArgumentError,
  BuildContext<Apps[number]> | StdioService | ToolRequestContext<Apps[number]>
>;
export function layerStdio(options: StdioOptions, ...apps: ReadonlyArray<AnyImplementation>) {
  return server(apps, McpServer.layerStdio(options));
}
