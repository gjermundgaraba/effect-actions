import { Layer } from "effect";
import type { Cause } from "effect";
import type { Stdio as StdioService } from "effect/Stdio";
import { McpProtocol, McpServer, type McpSchema } from "effect/unstable/ai";
import type { HttpRouter } from "effect/unstable/http";
import { bindTools } from "./internal/tools.js";
import {
  type AnyImplementation,
  type BuildContext,
  type BuildError,
  type AuthenticatedContext,
  type AuthenticatorContext,
  type AuthenticatorError,
  byAuthenticator,
  type Member,
  type RequestContext,
  type Served,
  toList,
} from "./internal/implementation.js";

/**
 * One Streamable HTTP MCP endpoint: every native `McpServer.layerHttp` option except
 * `protocols` (server information, `allowedOrigins`, `instructions`, `extensions`, ...),
 * with `path` defaulting to `/mcp`.
 */
interface Options extends Omit<Parameters<typeof McpServer.layerHttp>[0], "protocols" | "path"> {
  /** The endpoint's route; defaults to `/mcp`. */
  readonly path?: HttpRouter.PathInput;
}

/** An MCP subprocess on standard I/O: every native `McpServer.layerStdio` option except `protocols`. */
type StdioOptions = Omit<Parameters<typeof McpServer.layerStdio>[0], "protocols">;

/**
 * The one protocol revision served. 2026-07-28 is stateless over HTTP: no
 * initialize handshake and no session, so every request stands alone.
 */
const protocols = [McpProtocol.v2026_07_28] as const;

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
    binding.handlers,
  );
};

/**
 * Serve MCP tools over one Streamable HTTP endpoint, speaking MCP 2026-07-28 only.
 *
 * An endpoint is one route, so it authenticates as a whole: its implementations share one
 * `authenticate`, or none has one. Public tools go on an endpoint of their own. Middleware
 * provided around this layer has the normal HTTP lifetime. Native context capture applies:
 * never provide request-identity tags at startup.
 */
export function layerHttp<const Apps extends Served>(
  apps: Apps,
  options: Options,
): Layer.Layer<
  never,
  BuildError<Member<Apps>> | AuthenticatorError<Member<Apps>> | Cause.IllegalArgumentError,
  | BuildContext<Member<Apps>>
  | AuthenticatorContext<Member<Apps>>
  | HttpRouter.HttpRouter
  | HttpRouter.Request.From<"Requires", ToolRequestContext<AuthenticatedContext<Member<Apps>>>>
>;
export function layerHttp(served: Served, options: Options) {
  const apps = toList(served);
  const [authenticate, ...others] = byAuthenticator(apps).keys();

  if (others.length > 0) {
    throw new Error(
      "An MCP endpoint authenticates once: serve public tools and each authentication on endpoints of their own",
    );
  }

  const endpoint = server(
    apps,
    McpServer.layerHttp({ ...options, path: options.path ?? "/mcp", protocols }),
  );

  return authenticate === undefined ? endpoint : endpoint.pipe(Layer.provide(authenticate.layer));
}

/**
 * Serve MCP tools through newline-delimited JSON-RPC on standard I/O, speaking MCP
 * 2026-07-28 only. An older host is refused deliberately, for uniformity with HTTP,
 * even though stdio has no sessions.
 *
 * The host supplies the `Stdio` service. Arguments are tool input only and
 * never establish request identity or authority: an implementation's `authenticate` does
 * not run, and the host provides the identity, while its `before` hook does.
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
  return server(toList(apps), McpServer.layerStdio({ ...options, protocols }));
}
