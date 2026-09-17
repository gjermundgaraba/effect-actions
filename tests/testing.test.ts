import { expect, it } from "vite-plus/test";
import { mcpRequest } from "../src/Testing.js";

it("supplies consistent stateless protocol defaults", async () => {
  const request = mcpRequest({ url: "http://localhost/mcp", method: "tools/list" });
  const body = await request.json();
  expect(body).toMatchObject({
    params: {
      _meta: {
        "io.modelcontextprotocol/protocolVersion": request.headers.get("mcp-protocol-version"),
        "io.modelcontextprotocol/clientCapabilities": {},
        "io.modelcontextprotocol/clientInfo": { name: "test", version: "0" },
      },
    },
  });
});

it("preserves caller metadata and capabilities while pinning the wire protocol", async () => {
  const metadata = {
    "example.com/context": { actor: "alice" },
    "io.modelcontextprotocol/clientCapabilities": { experimental: { feature: true } },
    "io.modelcontextprotocol/clientInfo": { name: "consumer", version: "2" },
    "io.modelcontextprotocol/protocolVersion": "2025-11-25",
  };

  const request = mcpRequest({
    url: "http://localhost/mcp",
    method: "tools/call",
    params: { name: "inspect", arguments: {}, _meta: metadata },
  });

  expect(await request.json()).toMatchObject({
    params: {
      name: "inspect",
      arguments: {},
      _meta: { ...metadata, "io.modelcontextprotocol/protocolVersion": "2026-07-28" },
    },
  });
  expect(request.headers.get("mcp-protocol-version")).toBe("2026-07-28");
  expect(metadata["io.modelcontextprotocol/protocolVersion"]).toBe("2025-11-25");
});

it("accepts what JSON.stringify accepts, dropping undefined fields", async () => {
  const owner: string | undefined = undefined;

  const request = mcpRequest({
    url: "http://localhost/mcp",
    method: "tools/call",
    params: { name: "inspect", arguments: { owner, nested: [{ owner }] } },
  });

  expect(await request.json()).toMatchObject({
    params: { name: "inspect", arguments: { nested: [{}] } },
  });
});

it("preserves malformed tool names without inventing a routing header", async () => {
  const request = mcpRequest({
    url: "http://localhost/mcp",
    method: "tools/call",
    params: { name: 123, arguments: {} },
  });

  expect(request.headers.has("mcp-name")).toBe(false);
  expect(await request.json()).toMatchObject({ params: { name: 123, arguments: {} } });
});
