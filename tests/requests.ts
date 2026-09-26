import type { Schema } from "effect";
import { mcpMessage, type McpMessageOptions } from "../src/internal/mcp-request.js";

export const post = (path: string, body: Schema.Json = {}): Request =>
  new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

/** One stateless 2026-07-28 MCP request, as `Testing.mcpCall` sends it, to `path`. */
export const mcpRequest = ({
  path = "/mcp",
  ...message
}: McpMessageOptions & { readonly path?: string }): Request => {
  const { headers, body } = mcpMessage(message);

  return new Request(`http://localhost${path}`, { method: "POST", headers, body });
};

/** A raw `tools/call` request, for tests that assert the wire envelope `Testing.mcpCall` removes. */
export const rawToolCall = (name: string, args: Schema.Json = {}): Request =>
  mcpRequest({ method: "tools/call", params: { name, arguments: args } });
