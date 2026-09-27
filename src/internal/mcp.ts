import { McpProtocol } from "effect/unstable/ai";

/**
 * The one protocol revision served over HTTP. 2026-07-28 is stateless: every request
 * stands alone. The stateful revisions keep a session per `initialize`, which the native
 * HTTP runtime never expires and which no identity owns.
 */
export const httpProtocol = McpProtocol.v2026_07_28;

/** Where `ActionMcp.layerHttp` serves, and `Testing.mcpCall` calls, by default. */
export const defaultPath = "/mcp";
