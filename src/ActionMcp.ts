import { Cause, Effect, Exit, Fiber, Layer, Logger, Schema } from "effect";
import type { Stdio as StdioService } from "effect/Stdio";
import { McpProtocol, McpServer, type McpSchema, Tool } from "effect/ai";
import type { HttpRouter } from "effect/http";
import { defaultPath, httpProtocol } from "./internal/mcp.js";
import { recordStepUp, stepUp } from "./internal/refusal.js";
import { bindTools, type Projection } from "./internal/tools.js";
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
 * An MCP server, over HTTP or stdio: every native `McpServer.layerStdio` option except
 * `protocols`, the server information, `instructions` and `extensions`.
 */
export type Options = Omit<Parameters<typeof McpServer.layerStdio>[0], "protocols">;

/**
 * One Streamable HTTP MCP endpoint: every native `McpServer.layerHttp` option except
 * `protocols`, `Options` and `allowedOrigins` among them, with `path` defaulting to `/mcp`.
 */
export interface LayerHttpOptions extends Omit<
  Parameters<typeof McpServer.layerHttp>[0],
  "protocols" | "path"
> {
  /** The endpoint's route; defaults to `/mcp`. */
  readonly path?: HttpRouter.PathInput;
}

/**
 * The revisions served over stdio: 2026-07-28 and every stateful revision a host negotiates
 * with `initialize`, newest first. A success is the same `{ value }` text on each; revisions
 * before 2025-06-18 have no `structuredContent` to repeat it in, nor 2024-11-05 tool hints.
 */
const stdioProtocols = [
  McpProtocol.v2026_07_28,
  McpProtocol.v2025_11_25,
  McpProtocol.v2025_06_18,
  McpProtocol.v2025_03_26,
  McpProtocol.v2024_11_05,
] as const;

/**
 * The native server supplies its own request context to every tool call, and over HTTP
 * the router its own, such as the request.
 */
type ToolRequestContext<R> = Exclude<R, McpSchema.McpRequestContext>;

type HttpToolRequestContext<R> = Exclude<ToolRequestContext<R>, HttpRouter.Provided>;

/**
 * MCP has a JSON-only wire contract. Success uses its documented `{ value }`
 * structured-content envelope; declared failures are returned as JSON text. The native
 * server refuses undeclared arguments, publishes closed input schemas, and rejects any
 * input whose JSON Schema root is not an object. A step-up refusal is recorded, so that
 * over HTTP it answers the request.
 */
const tools: Projection = {
  label: "MCP tool",
  tool: (action, errors) =>
    Tool.make(action.name, {
      description: action.description,
      parameters: Schema.toCodecJson(action.input),
      success: Schema.toCodecJson(Schema.Struct({ value: action.success })),
      failure: Schema.toCodecJson(Schema.Union(errors)),
      failureMode: "return",
    }).annotate(Tool.Strict, true),
  handler: (run) => (input) => Effect.map(recordStepUp(run(input)), (value) => ({ value })),
};

const server = <Out, R>(
  apps: ReadonlyArray<AnyImplementation>,
  transport: Layer.Layer<Out, Cause.IllegalArgumentError, R>,
) => {
  const binding = bindTools(apps, tools);

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
 * lifetime. Tools under different middleware go on endpoints of their own. A call refused
 * with `Unauthenticated`, or with `Forbidden` naming scopes, is answered with its HTTP
 * status and challenge, 401 or 403, as MCP authorization requires; any other failure is a
 * tool result. Native context capture applies: never provide request-identity tags at
 * startup.
 */
export function layerHttp<const Apps extends Served>(
  implementations: Apps,
  options: LayerHttpOptions,
): Layer.Layer<
  never,
  BuildError<Member<Apps>> | Cause.IllegalArgumentError,
  | BuildContext<Member<Apps>>
  | HttpRouter.HttpRouter
  | HttpRouter.Request.From<"Requires", HttpToolRequestContext<RequestContext<Member<Apps>>>>
>;
export function layerHttp(apps: Served, options: LayerHttpOptions) {
  return server(
    toList(apps),
    McpServer.layerHttp({
      ...options,
      path: options.path ?? defaultPath,
      protocols: [httpProtocol],
    }).pipe(Layer.provide(stepUp)),
  );
}

/**
 * Serve MCP tools through newline-delimited JSON-RPC on standard I/O, speaking MCP
 * 2026-07-28 or any earlier revision back to 2024-11-05, as the host negotiates: the whole
 * program of an MCP subprocess, which succeeds when the host closes its side. A signal
 * interrupts it.
 *
 * Effect logs go to stderr, since stdout carries the protocol. The host supplies the
 * `Stdio` service and the identity. Arguments are tool input only and never establish
 * request identity or authority; each implementation's `before` hook runs.
 */
export function runStdio<const Apps extends Served>(
  implementations: Apps,
  options: Options,
): Effect.Effect<
  void,
  BuildError<Member<Apps>> | Cause.IllegalArgumentError,
  BuildContext<Member<Apps>> | StdioService | ToolRequestContext<RequestContext<Member<Apps>>>
>;
export function runStdio(apps: Served, options: Options) {
  const transport = server(
    toList(apps),
    McpServer.layerStdio({ ...options, protocols: stdioProtocols }),
  );

  // The native transport ends by interrupting the fiber that built it once the host closes
  // its side. Built in a child, that is a normal end, while an interruption of the program
  // itself, such as a signal, stays one. Stdout carries the protocol, so logs go to stderr.
  return Layer.launch(transport).pipe(
    Effect.provideService(Logger.LogToStderr, true),
    Effect.forkChild,
    Effect.flatMap(Fiber.await),
    Effect.flatMap((exit) =>
      Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause)
        ? Effect.failCause(exit.cause)
        : Effect.void,
    ),
  );
}
