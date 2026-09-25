import { Layer } from "effect";
import type { Cause } from "effect";
import type { Stdio as StdioService } from "effect/Stdio";
import { McpProtocol, McpServer, type McpSchema } from "effect/unstable/ai";
import type { HttpRouter } from "effect/unstable/http";
import type * as Action from "./Action.js";
import { bindTools, type SurfaceOptions, type ToolOptions } from "./internal/tools.js";
import {
  type AnyImplementation,
  type BuildContext,
  type BuildError,
  type Member,
  type RequestContext,
  type Served,
  toList,
} from "./internal/implementation.js";

/**
 * One Streamable HTTP MCP endpoint: every native `McpServer.layerHttp` option except
 * `protocols` (server information, `allowedOrigins`, `instructions`, `extensions`, ...),
 * with `path` defaulting to `/mcp`, plus the surface's `errors` and `before`.
 */
export interface Options<Errors extends ReadonlyArray<Action.Codec> = [], R = never>
  extends
    Omit<Parameters<typeof McpServer.layerHttp>[0], "protocols" | "path">,
    SurfaceOptions<Errors, R> {
  /** The endpoint's route; defaults to `/mcp`. */
  readonly path?: HttpRouter.PathInput;
}

/** An MCP subprocess on standard I/O: every native `McpServer.layerStdio` option except `protocols`. */
export interface StdioOptions<Errors extends ReadonlyArray<Action.Codec> = [], R = never>
  extends
    Omit<Parameters<typeof McpServer.layerStdio>[0], "protocols">,
    SurfaceOptions<Errors, R> {}

/**
 * The one protocol revision served. 2026-07-28 is stateless over HTTP: no
 * initialize handshake and no session, so every request stands alone.
 */
const protocols = [McpProtocol.v2026_07_28] as const;

/** The native server supplies its own request context to every tool call. */
type ToolRequestContext<App, RB> = Exclude<RequestContext<App> | RB, McpSchema.McpRequestContext>;

const server = <Out, R>(
  apps: ReadonlyArray<AnyImplementation>,
  options: ToolOptions,
  transport: Layer.Layer<Out, Cause.IllegalArgumentError, R>,
) => {
  const binding = bindTools(apps, "mcp", options);

  return Layer.effectDiscard(McpServer.registerToolkit(binding.toolkit)).pipe(
    Layer.provide(binding.layer),
    Layer.provide(transport),
    // The native registry is mutable; every endpoint/subprocess gets its own one. Only
    // the registry: handlers are provided outside it, so builders stay shared.
    Layer.fresh,
    binding.handlers,
  );
};

/**
 * Serve MCP tools over one Streamable HTTP endpoint, speaking MCP 2026-07-28 only.
 *
 * Middleware provided around this layer has the normal HTTP lifetime. Native
 * context capture applies: never provide request-identity tags at startup.
 */
export function layerHttp<
  const Apps extends Served,
  const Errors extends ReadonlyArray<Action.Codec> = [],
  RB = never,
>(
  apps: Apps,
  options: Options<Errors, RB>,
): Layer.Layer<
  never,
  BuildError<Member<Apps>> | Cause.IllegalArgumentError,
  | BuildContext<Member<Apps>>
  | HttpRouter.HttpRouter
  | HttpRouter.Request.From<"Requires", ToolRequestContext<Member<Apps>, RB>>
>;
export function layerHttp(apps: Served, options: Options<ReadonlyArray<Action.Codec>, unknown>) {
  return server(
    toList(apps),
    options,
    McpServer.layerHttp({ ...options, path: options.path ?? "/mcp", protocols }),
  );
}

/**
 * Serve MCP tools through newline-delimited JSON-RPC on standard I/O, speaking MCP
 * 2026-07-28 only. An older host is refused deliberately, for uniformity with HTTP,
 * even though stdio has no sessions.
 *
 * The host supplies the `Stdio` service. Arguments are tool input only and
 * never establish request identity or authority.
 */
export function layerStdio<
  const Apps extends Served,
  const Errors extends ReadonlyArray<Action.Codec> = [],
  RB = never,
>(
  apps: Apps,
  options: StdioOptions<Errors, RB>,
): Layer.Layer<
  never,
  BuildError<Member<Apps>> | Cause.IllegalArgumentError,
  BuildContext<Member<Apps>> | StdioService | ToolRequestContext<Member<Apps>, RB>
>;
export function layerStdio(
  apps: Served,
  options: StdioOptions<ReadonlyArray<Action.Codec>, unknown>,
) {
  return server(toList(apps), options, McpServer.layerStdio({ ...options, protocols }));
}
