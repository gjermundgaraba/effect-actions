import type { Schema } from "effect";
import { mcpRequest } from "../src/Testing.js";
import { testMcpUrl } from "./server.js";

export const post = (path: string, body: Schema.Json = {}): Request =>
  new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

/** A raw `tools/call` request, for tests that assert the wire envelope `Testing.mcpCall` removes. */
export const rawToolCall = (name: string, args: Schema.Json = {}): Request =>
  mcpRequest({ url: testMcpUrl, method: "tools/call", params: { name, arguments: args } });
