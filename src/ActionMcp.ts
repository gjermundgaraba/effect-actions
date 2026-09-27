import { Layer } from "effect";
import type { Cause } from "effect";
import type { Stdio as StdioService } from "effect/Stdio";
import { McpProtocol, McpServer, type McpSchema } from "effect/unstable/ai";
import type { HttpRouter } from "effect/unstable/http";
import { defaultPath, httpProtocol } from "./internal/mcp.js";
import { preflight } from "./internal/refusal.js";
import { bindTools } from "./internal/tools.js";
import {
  type AnyImplementation,
  type BuildContext,
  type BuildError,
  type Member,
  provideHandlers,
  type RequestContext,
  type Served,
  toList,
} from "./internal/implementation.js";

/**
 * One Streamable HTTP MCP endpoint: every native `McpServer.layerHttp` option except
 * `protocols` (server information, `allowedOrigins`, `instructions`, `extensions`, ...),
 * with `path` defaulting to `/mcp`.
 */
export interface HttpOptions extends Omit<
  Parameters<typeof McpServer.layerHttp>[0],
  "protocols" | "path"
> {
  /** The endpoint's route; defaults to `/mcp`. */
  readonly path?: HttpRouter.PathInput;
}

/** An MCP subprocess on standard I/O: every native `McpServer.layerStdio` option except `protocols`. */
export type StdioOptions = Omit<Parameters<typeof McpServer.layerStdio>[0], "protocols">;

/**
 * The revisions served over stdio: 2026-07-28 and the stateful revisions a host
 * negotiates with `initialize`, newest first. Each carries `structuredContent`, so a
 * success has one shape on every revision; older ones do not, and are refused.
 */
const stdioProtocols = [
  McpProtocol.v2026_07_28,
  McpProtocol.v2025_11_25,
  McpProtocol.v2025_06_18,
] as const;

/** The native server supplies its own request context to every tool call. */
type ToolRequestContext<R> = Exclude<R, McpSchema.McpRequestContext>;

const server = <Out, R>(
  apps: ReadonlyArray<AnyImplementation>,
  transport: Layer.Layer<Out, Cause.IllegalArgumentError, R>,
) => {
  const binding = bindTools(apps, "mcp");

  return Layer.effectDiscard(McpServer.registerToolkit(binding.toolkit)).pipe(
    Layer.provide(binding.layer),
    Layer.provide(transport),
    // The native registry is mutable; every endpoint/subprocess gets its own one. Only
    // the registry: handlers are provided outside it, so builders stay shared.
    Layer.fresh,
    provideHandlers(apps),
  );
};

/**
 * Serve MCP tools over one Streamable HTTP endpoint, speaking MCP 2026-07-28 only.
 *
 * An endpoint is one route: middleware provided around this layer, such as
 * authentication, covers every tool of it, tool listing included, with the normal HTTP
 * lifetime. Tools under different middleware go on endpoints of their own. Each call's
 * `before` hook runs before its body is read, and a refusal is its HTTP status, 401 or 403,
 * as MCP authorization requires. Native context capture applies: never provide
 * request-identity tags at startup.
 */
export function layerHttp<const Apps extends Served>(
  apps: Apps,
  options: HttpOptions,
): Layer.Layer<
  never,
  BuildError<Member<Apps>> | Cause.IllegalArgumentError,
  | BuildContext<Member<Apps>>
  | HttpRouter.HttpRouter
  | HttpRouter.Request.From<"Requires", ToolRequestContext<RequestContext<Member<Apps>>>>
>;
export function layerHttp(apps: Served, options: HttpOptions) {
  const served = toList(apps);

  // A 2026-07-28 call names its tool in its headers, which the native server checks against
  // its body, so the hook runs before the body is read, and a refusal is an HTTP status an
  // OAuth client re-authorizes on rather than a tool result.
  const hooks = preflight(served, (bound) => {
    const tools = new Map(bound.map((entry) => [entry[0].name, entry]));

    return (request) =>
      request.headers["mcp-method"] === "tools/call"
        ? tools.get(request.headers["mcp-name"] ?? "")
        : undefined;
  });

  return server(
    served,
    McpServer.layerHttp({
      ...options,
      path: options.path ?? defaultPath,
      protocols: [httpProtocol],
    }).pipe(Layer.provide(hooks)),
  );
}

/**
 * Serve MCP tools through newline-delimited JSON-RPC on standard I/O, speaking MCP
 * 2026-07-28, 2025-11-25 or 2025-06-18, as the host negotiates.
 *
 * The host supplies the `Stdio` service and the identity. Arguments are tool input only
 * and never establish request identity or authority; each implementation's `before` hook
 * runs.
 */
export function layerStdio<const Apps extends Served>(
  apps: Apps,
  options: StdioOptions,
): Layer.Layer<
  never,
  BuildError<Member<Apps>> | Cause.IllegalArgumentError,
  BuildContext<Member<Apps>> | StdioService | ToolRequestContext<RequestContext<Member<Apps>>>
>;
export function layerStdio(apps: Served, options: StdioOptions) {
  return server(toList(apps), McpServer.layerStdio({ ...options, protocols: stdioProtocols }));
}
