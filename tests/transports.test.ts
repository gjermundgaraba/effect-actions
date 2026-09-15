import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { Effect, Schema } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http";
import { HttpApiClient } from "effect/unstable/httpapi";
import { makeTestApp } from "./http.js";
import { api } from "../examples/app.js";
import { ActionHttp } from "../src/index.js";
import { Actions } from "../examples/contracts.js";

let app: ReturnType<typeof makeTestApp>;
beforeEach(() => {
  app = makeTestApp();
});
afterEach(async () => {
  await app.close();
});

const request = (path: string, token = "alice", body?: unknown, method?: string) =>
  new Request(`http://localhost${path}`, {
    method: method ?? (body === undefined ? "GET" : "POST"),
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

// Semantic tests use the SDK; registration.test.ts retains hand-crafted wire coverage.
const withMcp = async <A>(run: (client: Client) => Promise<A>, token = "alice") => {
  const client = new Client(
    { name: "test", version: "0" },
    { versionNegotiation: { mode: { pin: "2026-07-28" } } },
  );
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL("http://localhost/mcp"), {
        requestInit: { headers: { authorization: `Bearer ${token}` } },
        fetch: (input, init) => app.fetch(new Request(input, init)),
      }),
    );
    return await run(client);
  } finally {
    await client.close();
  }
};
const tool = (name: string, args: Record<string, unknown>, token = "alice") =>
  withMcp((client) => client.callTool({ name, arguments: args }), token);

describe("one implementation, both transports", () => {
  it("serves generated POST endpoints with the natural encoding", async () => {
    const response = await app.fetch(request("/api/actions/getUser", "alice", { id: "1" }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ id: "1", name: "Ada" });
  });

  it("exposes schemas and renamed MCP tools from the same contracts", async () => {
    const reply = await withMcp((client) => client.listTools());
    expect(reply.tools.map((tool) => tool.name)).toEqual([
      "get_user",
      "rename_user",
      "double",
      "whoAmI",
    ]);
    const double = reply.tools.find((tool) => tool.name === "double");
    expect(double?.inputSchema.properties).toEqual({ value: { type: "string" } });
    expect(double?.outputSchema?.properties).toEqual({ value: { type: "number" } });
  });

  it("decodes input transforms on both transports; MCP wraps results as { value }", async () => {
    const http = await app.fetch(request("/api/actions/double", "alice", { value: "21" }));
    expect(await http.json()).toBe(42);
    const reply = await tool("double", { value: "21" });
    expect(reply.isError).toBe(false);
    expect(reply.structuredContent).toEqual({ value: 42 });
  });

  it("a write through MCP is immediately visible through HTTP", async () => {
    const reply = await tool("rename_user", { id: "1", name: "Lovelace" });
    expect(reply.isError).toBe(false);
    const response = await app.fetch(request("/api/actions/getUser", "alice", { id: "1" }));
    expect(await response.json()).toEqual({ id: "1", name: "Lovelace" });
    const other = await app.fetch(request("/api/actions/getUser", "bob", { id: "1" }));
    expect(await other.json()).toEqual({ id: "1", name: "Grace" });
  });

  it("a write through HTTP is immediately visible through MCP", async () => {
    await app.fetch(request("/api/actions/renameUser", "alice", { id: "1", name: "Byron" }));
    expect((await tool("get_user", { id: "1" })).structuredContent).toEqual({
      value: { id: "1", name: "Byron" },
    });
  });

  it("preserves structured domain errors, with transport-specific status", async () => {
    const http = await app.fetch(request("/api/actions/getUser", "alice", { id: "missing" }));
    expect(http.status).toBe(404);
    const body = await http.json();
    expect(body).toEqual({ _tag: "UserNotFound", id: "missing" });
    const reply = await tool("get_user", { id: "missing" });
    expect(reply.isError).toBe(true);
    expect(reply.structuredContent).toEqual(body);
  });

  it("rejects malformed input with each protocol's native error", async () => {
    expect(
      (await app.fetch(request("/api/actions/double", "alice", { value: "nope" }))).status,
    ).toBe(400);
    expect(await tool("double", { value: "nope" })).toMatchObject({ isError: true });
    expect(
      (await app.fetch(request("/api/actions/renameUser", "alice", { id: "1", name: "" }))).status,
    ).toBe(400);
  });

  it("the host's authorization runs on every call; discovery is not filtered per actor", async () => {
    // Native McpServer registers tools once, so tools/list is the same for every actor.
    const reply = await withMcp((client) => client.listTools(), "reader");
    expect(reply.tools.map((tool) => tool.name)).toContain("rename_user");
    const denied = await tool("rename_user", { id: "1", name: "unauthorized" }, "reader");
    expect(denied.isError).toBe(true);
    expect(denied.structuredContent).toEqual({
      _tag: "Forbidden",
      permission: "users:write",
    });
    const forbidden = await app.fetch(
      request("/api/actions/renameUser", "reader", { id: "1", name: "unauthorized" }),
    );
    expect(forbidden.status).toBe(403);
    expect(await forbidden.json()).toEqual(denied.structuredContent);
    expect(
      await (await app.fetch(request("/api/actions/getUser", "alice", { id: "1" }))).json(),
    ).toEqual({
      id: "1",
      name: "Ada",
    });
  });

  it("keeps concurrent request actors isolated over MCP", async () => {
    const requests = Array.from({ length: 20 }, (_, i) => (i % 2 === 0 ? "alice" : "bob"));
    const results = await Promise.all(requests.map((token) => tool("whoAmI", {}, token)));
    for (const [i, reply] of results.entries()) {
      const id = requests[i];
      expect(reply.structuredContent).toEqual({
        value: { id, tenantId: id === "alice" ? "acme" : "other" },
      });
    }
  });

  it("never derives authority from action arguments or MCP metadata", async () => {
    const args = { id: "1", actor: { id: "bob", tenantId: "other" }, tenantId: "other" };
    // Effect's default object behavior strips excess fields on both paths.
    const reply = await tool("get_user", args);
    expect(reply.structuredContent).toEqual({ value: { id: "1", name: "Ada" } });
    const spoof = await withMcp((client) =>
      client.callTool({
        name: "get_user",
        arguments: { id: "1" },
        _meta: { actor: { id: "bob", tenantId: "other" } },
      }),
    );
    expect(spoof.structuredContent).toEqual({ value: { id: "1", name: "Ada" } });
  });

  it("keeps concurrent request actors isolated over HTTP", async () => {
    const tokens = Array.from({ length: 20 }, (_, index) => (index % 2 === 0 ? "alice" : "bob"));
    const responses = await Promise.all(
      tokens.map(async (token) =>
        (await app.fetch(request("/api/actions/whoAmI", token, {}))).json(),
      ),
    );
    expect(responses).toEqual(
      tokens.map((id) => ({ id, tenantId: id === "alice" ? "acme" : "other" })),
    );
  });

  it("authenticates both transports before execution", async () => {
    for (const path of ["/api/actions/getUser", "/mcp"]) {
      const response = await app.fetch(new Request(`http://localhost${path}`, { method: "POST" }));
      expect(response.status).toBe(401);
      expect(response.headers.get("www-authenticate")).toBe("Bearer");
      expect(await response.json()).toMatchObject({ _tag: "Unauthenticated" });
    }
    expect((await app.fetch(request("/api/actions/getUser", "toString", { id: "1" }))).status).toBe(
      401,
    );
  });

  it("marks authenticated responses as uncacheable", async () => {
    const response = await app.fetch(request("/api/actions/getUser", "alice", { id: "1" }));
    expect(response.headers.get("cache-control")).toBe("no-store");
    const failure = await app.fetch(request("/api/actions/getUser", "alice", { id: "missing" }));
    expect(failure.headers.get("cache-control")).toBe("no-store");
  });

  it("rejects untrusted hosts and browser origins in the example host", async () => {
    const foreign = new Request("http://evil.example/api/actions/getUser", {
      method: "POST",
      headers: { authorization: "Bearer alice" },
    });
    expect((await app.fetch(foreign)).status).toBe(403);
    const crossOrigin = request("/api/actions/getUser", "alice", { id: "1" });
    crossOrigin.headers.set("origin", "https://evil.example");
    expect((await app.fetch(crossOrigin)).status).toBe(403);
  });

  it("uses native Effect HTTP request semantics", async () => {
    expect((await app.fetch(request("/does-not-exist"))).status).toBe(404);
    expect((await app.fetch(request("/api/actions/getUser"))).status).toBe(404);
    const malformed = new Request(request("/api/actions/double", "alice", {}), {
      method: "POST",
      body: "{",
    });
    expect((await app.fetch(malformed)).status).toBe(400);
    const wrongType = request("/api/actions/double", "alice", {});
    wrongType.headers.set("content-type", "text/plain");
    expect((await app.fetch(wrongType)).status).toBe(415);
  });

  it("derives OpenAPI request/response contracts, including declared errors", async () => {
    const schema = Schema.Struct({
      openapi: Schema.String,
      paths: Schema.JsonObject,
      components: Schema.Struct({ schemas: Schema.JsonObject }),
    });
    const document = Schema.decodeUnknownSync(schema)(
      await (await app.fetch(request("/openapi.json"))).json(),
    );
    expect(document.openapi).toBe("3.1.0");
    expect(Object.keys(document.paths)).toEqual([
      "/api/actions/getUser",
      "/api/actions/renameUser",
      "/api/actions/double",
      "/api/actions/whoAmI",
    ]);
    expect(document.paths["/api/actions/getUser"]).toMatchObject({
      post: {
        operationId: "actions.getUser",
        tags: ["actions"],
        requestBody: {
          content: { "application/json": { schema: { properties: { id: { type: "string" } } } } },
        },
        responses: {
          "200": {},
          "403": {
            content: {
              "application/json": { schema: { $ref: "#/components/schemas/ForbiddenEncoded" } },
            },
          },
          "404": {
            content: {
              "application/json": { schema: { $ref: "#/components/schemas/UserNotFoundEncoded" } },
            },
          },
        },
      },
    });
    expect(document.paths["/api/actions/double"]).toMatchObject({
      post: {
        requestBody: {
          content: {
            "application/json": { schema: { properties: { value: { type: "string" } } } },
          },
        },
      },
    });
    const doubleOperation = ActionHttp.openapi(Actions).paths?.["/api/actions/double"]?.post;
    expect(doubleOperation?.operationId).toBe("actions.double");
    expect(doubleOperation?.responses).not.toHaveProperty("404");
    expect(Object.keys(document.components.schemas)).toContain("UserNotFoundEncoded");
  });

  it("serves the generated contract through Effect's native HttpApiClient", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* HttpApiClient.make(api, {
          baseUrl: "http://localhost",
          transformClient: (client) =>
            client.pipe(HttpClient.mapRequest(HttpClientRequest.bearerToken("alice"))),
        });
        // The typed client encodes decoded 21 to the wire string and decodes the reply.
        const result: number = yield* client.actions.double({ payload: { value: 21 } });
        return result;
      }).pipe(
        Effect.provide(FetchHttpClient.layer),
        Effect.provideService(FetchHttpClient.Fetch, (input, init) =>
          app.fetch(new Request(input, init)),
        ),
      ),
    );
    expect(result).toBe(42);
  });

  it.each(["legacy", "modern"] as const)(
    "supports the official v2 MCP client in %s mode",
    async (era) => {
      const versions = new Set<string | null>();
      const client = new Client(
        { name: "test", version: "1.0.0" },
        { versionNegotiation: { mode: era === "modern" ? { pin: "2026-07-28" } : "legacy" } },
      );
      const transport = new StreamableHTTPClientTransport(new URL("http://localhost/mcp"), {
        requestInit: { headers: { authorization: "Bearer alice" } },
        fetch: (input, init) => {
          const req = new Request(input, init);
          versions.add(req.headers.get("mcp-protocol-version"));
          return app.fetch(req);
        },
      });
      try {
        await client.connect(transport);
        const tools = await client.listTools();
        expect(tools.tools.map((tool) => tool.name)).toContain("double");
        const result = await client.callTool({ name: "double", arguments: { value: "7" } });
        expect(result.structuredContent).toEqual({ value: 14 });
        const failure = await client.callTool({ name: "get_user", arguments: { id: "missing" } });
        expect(failure.isError).toBe(true);
        expect(failure.structuredContent).toEqual({ _tag: "UserNotFound", id: "missing" });
        expect(versions).toContain(era === "modern" ? "2026-07-28" : "2025-11-25");
      } finally {
        await client.close();
      }
    },
  );
});
