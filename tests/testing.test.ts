import { describe, expect, it, onTestFinished } from "vite-plus/test";
import { mcpCall, mcpRequest } from "../src/Testing.js";
import { makeTestApp, testMcpUrl } from "./server.js";
import { Forbidden } from "../examples/auth.js";
import { UserNotFound } from "../examples/contracts.js";
import { Schema } from "effect";

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

it("accepts undefined parameter fields and drops them from the request body", async () => {
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

describe("mcpCall", () => {
  const serve = () => {
    const web = makeTestApp();
    onTestFinished(() => web.dispose());

    return (name: string, input: Parameters<typeof mcpCall>[1]["arguments"], token = "alice") =>
      mcpCall(web.handler, {
        url: testMcpUrl,
        name,
        ...(input === undefined ? {} : { arguments: input }),
        headers: { authorization: `Bearer ${token}` },
      });
  };

  it("returns a success without the `{ value }` envelope", async () => {
    const call = serve();

    expect(await call("get_user", { id: "1" })).toEqual({
      isError: false,
      value: { id: "1", name: "Ada" },
    });
    expect(await call("double", { value: "21" })).toEqual({ isError: false, value: 42 });
    expect(await call("whoAmI", undefined)).toEqual({
      isError: false,
      value: { id: "alice", tenantId: "acme" },
    });
  });

  it("returns a declared or refused error as its decoded JSON", async () => {
    const call = serve();

    expect(await call("get_user", { id: "404" })).toEqual({
      isError: true,
      error: Schema.encodeSync(UserNotFound)(new UserNotFound({ id: "404" })),
    });
    expect(await call("rename_user", { id: "1", name: "Grace" }, "reader")).toEqual({
      isError: true,
      error: Schema.encodeSync(Forbidden)(new Forbidden({ permission: "users:write" })),
    });
  });

  it("returns the native message of an error that is not JSON", async () => {
    const call = serve();
    const result = await call("get_user", { id: 1 });

    expect(result.isError).toBe(true);
    expect(result.isError && result.error).toEqual(
      expect.stringContaining("Invalid parameters for tool 'get_user'"),
    );
  });

  it("throws for an answer that is not a tool result", async () => {
    const call = serve();

    await expect(call("get_user", { id: "1" }, "nobody")).rejects.toThrow(
      'MCP tools/call "get_user" answered 401',
    );
    await expect(call("missing_tool", {})).rejects.toThrow('MCP tools/call "missing_tool"');
  });

  it("reads the reply from an event stream that carries notifications first", async () => {
    const stream = [
      { jsonrpc: "2.0", method: "notifications/message", params: { level: "info", data: "x" } },
      { jsonrpc: "2.0", id: 1, result: { content: [], structuredContent: { value: [1, 2] } } },
    ]
      .map((message) => `data: ${JSON.stringify(message)}\n\n`)
      .join("");

    const result = await mcpCall(
      async () => new Response(stream, { headers: { "content-type": "text/event-stream" } }),
      { url: testMcpUrl, name: "listed" },
    );

    expect(result).toEqual({ isError: false, value: [1, 2] });
  });
});
