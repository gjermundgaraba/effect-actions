import { afterEach, beforeEach, describe, expect, it, onTestFinished } from "vite-plus/test";
import type { Client } from "@modelcontextprotocol/client";
import { Effect, Layer, Predicate, Schema } from "effect";
import { McpProtocol, McpSchema } from "effect/unstable/ai";
import { HttpClient, HttpClientRequest, HttpRouter, HttpServer } from "effect/unstable/http";
import { OpenApi } from "effect/unstable/httpapi";
import * as Action from "../src/Action.js";
import * as ActionGroup from "../src/ActionGroup.js";
import * as ActionMcp from "../src/ActionMcp.js";
import { makeTestApp, testMcpPath } from "./server.js";
import { Http, InvalidRequest, UserNotFound } from "../examples/contracts.js";
import { Forbidden } from "../examples/auth.js";
import { httpClient, mcpRequest } from "../src/Testing.js";
import { withMcpClient } from "../src/TestingClient.js";

let app: ReturnType<typeof makeTestApp>;

beforeEach(() => {
  app = makeTestApp();
});

afterEach(async () => {
  await app.dispose();
});

const request = (path: string, token = "alice", body?: Schema.Json, method?: string) => {
  const init: RequestInit = {
    method: method ?? (body === undefined ? "GET" : "POST"),
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
  };

  if (body !== undefined) init.body = JSON.stringify(body);

  return new Request(`http://localhost${path}`, init);
};

const anonymous = (path: string, body?: Schema.Json) => {
  const init: RequestInit = { headers: { "content-type": "application/json" } };

  if (body !== undefined) {
    init.method = "POST";
    init.body = JSON.stringify(body);
  }

  return new Request(`http://localhost${path}`, init);
};

const authenticatedFetch = (token: string) => (request: Request) => {
  request.headers.set("authorization", `Bearer ${token}`);

  return app.handler(request);
};

const withMcp = <A>(run: (client: Client) => Promise<A>, token = "alice") =>
  withMcpClient(
    {
      versionNegotiation: { mode: { pin: "2026-07-28" } },
      fetch: authenticatedFetch(token),
      path: testMcpPath,
    },
    run,
  );

const tool = (name: string, args: Schema.JsonObject, token = "alice") =>
  withMcp((client) => client.callTool({ name, arguments: args }), token);

describe("one implementation, both transports", () => {
  it("exposes schemas and renamed MCP tools from the same contracts", async () => {
    const reply = await withMcp((client) => client.listTools());
    expect(reply.tools.map((tool) => tool.name)).toEqual([
      "get_user",
      "rename_user",
      "double",
      "whoAmI",
      "list_changes",
    ]);
    const double = reply.tools.find((tool) => tool.name === "double");
    expect(double?.inputSchema.properties).toEqual({ value: { type: "string" } });
    expect(double?.outputSchema?.properties).toEqual({ value: { type: "number" } });
  });

  it("decodes input transforms on both transports; MCP wraps results as { value }", async () => {
    const http = await app.handler(request("/api/actions/users/double", "alice", { value: "21" }));
    expect(await http.json()).toBe(42);
    const reply = await tool("double", { value: "21" });
    expect(reply.isError).toBe(false);
    expect(reply.structuredContent).toEqual({ value: 42 });
  });

  it("a write through MCP is immediately visible through HTTP", async () => {
    const reply = await tool("rename_user", { id: "1", name: "Lovelace" });
    expect(reply.isError).toBe(false);
    const response = await app.handler(request("/api/actions/users/getUser", "alice", { id: "1" }));
    expect(await response.json()).toEqual({ id: "1", name: "Lovelace" });
    const other = await app.handler(request("/api/actions/users/getUser", "bob", { id: "1" }));
    expect(await other.json()).toEqual({ id: "1", name: "Grace" });
  });

  it("serves domain errors structured over HTTP and as text over MCP", async () => {
    const http = await app.handler(
      request("/api/actions/users/getUser", "alice", { id: "missing" }),
    );

    expect(http.status).toBe(404);
    const body = await http.json();
    expect(body).toEqual(Schema.encodeSync(UserNotFound)(new UserNotFound({ id: "missing" })));
    const reply = await tool("get_user", { id: "missing" });
    expect(reply.isError).toBe(true);
    expect(reply.structuredContent).toBeUndefined();
    // UserNotFound has no message field, so the text is its encoding.
    expect(reply.content).toEqual([{ type: "text", text: JSON.stringify(body) }]);
  });

  it("rejects malformed input with each protocol's native error", async () => {
    expect(
      (await app.handler(request("/api/actions/users/double", "alice", { value: "nope" }))).status,
    ).toBe(400);
    expect(await tool("double", { value: "nope" })).toMatchObject({ isError: true });
    expect(
      (await app.handler(request("/api/actions/users/renameUser", "alice", { id: "1", name: "" })))
        .status,
    ).toBe(400);
  });

  it("the host's authorization runs on every call; discovery is not filtered per actor", async () => {
    // Native McpServer registers tools once, so tools/list is the same for every actor.
    const reply = await withMcp((client) => client.listTools(), "reader");
    expect(reply.tools.map((tool) => tool.name)).toContain("rename_user");
    const denied = await tool("rename_user", { id: "1", name: "unauthorized" }, "reader");
    expect(denied.isError).toBe(true);

    const forbiddenBody = Schema.encodeSync(Forbidden)(
      new Forbidden({ permission: "users:write" }),
    );

    expect(denied.content).toEqual([{ type: "text", text: JSON.stringify(forbiddenBody) }]);

    const forbidden = await app.handler(
      request("/api/actions/users/renameUser", "reader", { id: "1", name: "unauthorized" }),
    );

    expect(forbidden.status).toBe(403);
    expect(await forbidden.json()).toEqual(forbiddenBody);
    expect(
      await (await app.handler(request("/api/actions/users/getUser", "alice", { id: "1" }))).json(),
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
        (await app.handler(request("/api/actions/users/whoAmI", token, {}))).json(),
      ),
    );

    expect(responses).toEqual(
      tokens.map((id) => ({ id, tenantId: id === "alice" ? "acme" : "other" })),
    );
  });

  it("authenticates both transports before execution", async () => {
    for (const path of ["/api/actions/users/getUser", "/mcp"]) {
      const response = await app.handler(
        new Request(`http://localhost${path}`, { method: "POST" }),
      );

      expect(response.status).toBe(401);
      expect(response.headers.get("www-authenticate")).toBe("Bearer");
      expect(Predicate.isTagged("Unauthenticated")(await response.json())).toBe(true);
    }

    expect(
      (await app.handler(request("/api/actions/users/getUser", "toString", { id: "1" }))).status,
    ).toBe(401);
  });

  it("rejects untrusted hosts and browser origins in the example host", async () => {
    const foreign = new Request("http://evil.example/api/actions/users/getUser", {
      method: "POST",
      headers: { authorization: "Bearer alice" },
    });

    expect((await app.handler(foreign)).status).toBe(403);

    // The policy is the host's outermost layer, so it covers the credential-free group too.
    const foreignPublic = new Request(
      "http://attacker.example/api/actions/public/status",
      anonymous("/api/actions/public/status", {}),
    );

    expect((await app.handler(foreignPublic)).status).toBe(403);
    const crossOrigin = request("/api/actions/users/getUser", "alice", { id: "1" });
    crossOrigin.headers.set("origin", "https://evil.example");
    expect((await app.handler(crossOrigin)).status).toBe(403);
  });

  it("uses the documented HTTP input error statuses", async () => {
    const malformed = new Request(request("/api/actions/users/double", "alice", {}), {
      method: "POST",
      body: "{",
    });

    const wrongType = request("/api/actions/users/double", "alice", {});
    wrongType.headers.set("content-type", "text/plain");

    expect((await app.handler(malformed)).status).toBe(400);
    expect((await app.handler(wrongType)).status).toBe(415);
  });

  it("derives OpenAPI request/response contracts, including declared errors", async () => {
    const schema = Schema.Struct({
      openapi: Schema.String,
      paths: Schema.JsonObject,
      components: Schema.Struct({ schemas: Schema.JsonObject }),
    });

    const document = Schema.decodeUnknownSync(schema)(
      await (await app.handler(request("/openapi.json"))).json(),
    );

    expect(document.openapi).toBe("3.1.0");
    expect(Object.keys(document.paths)).toEqual([
      "/api/actions/public/status",
      "/api/actions/users/getUser",
      "/api/actions/users/renameUser",
      "/api/actions/users/double",
      "/api/actions/users/whoAmI",
    ]);
    expect(document.paths["/api/actions/users/getUser"]).toMatchObject({
      post: {
        operationId: "users.getUser",
        tags: ["users"],
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
    expect(document.paths["/api/actions/users/double"]).toMatchObject({
      post: {
        requestBody: {
          content: {
            "application/json": { schema: { properties: { value: { type: "string" } } } },
          },
        },
      },
    });

    const doubleOperation = OpenApi.fromApi(Http.api).paths?.["/api/actions/users/double"]?.post;

    expect(doubleOperation?.operationId).toBe("users.double");
    expect(doubleOperation?.responses).not.toHaveProperty("404");
    expect(Object.keys(document.components.schemas)).toContain("UserNotFoundEncoded");
  });
});

describe("groups under their own middleware", () => {
  it("serves the public group and the document without credentials, the user group only with them", async () => {
    const status = await app.handler(anonymous("/api/actions/public/status", {}));
    expect(status.status).toBe(200);
    expect(await status.json()).toEqual({ service: "effect-actions", users: 2 });

    const document = await app.handler(anonymous("/openapi.json"));
    expect(document.status).toBe(200);
    expect(await document.json()).toEqual(OpenApi.fromApi(Http.api));

    const unauthenticated = await app.handler(anonymous("/api/actions/users/whoAmI", {}));
    expect(unauthenticated.status).toBe(401);
    expect(unauthenticated.headers.get("www-authenticate")).toBe("Bearer");
    expect((await app.handler(request("/api/actions/users/whoAmI", "alice", {}))).status).toBe(200);
  });

  it("calls every group through one native grouped client, with the shared policy errors", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* httpClient(Http.api, app.handler, {
          transformClient: HttpClient.mapRequest(HttpClientRequest.bearerToken("alice")),
        });

        return {
          status: yield* client.public.status({ payload: {} }),
          identity: yield* client.users.whoAmI({ payload: {} }),
        };
      }),
    );

    expect(result.status.users).toBe(2);
    expect(result.identity).toEqual({ id: "alice", tenantId: "acme" });

    // The typed client validates locally, so the server's policy needs a raw request.
    const rejected = await app.handler(
      request("/api/actions/users/renameUser", "alice", { id: "1", name: "" }),
    );

    expect(rejected.status).toBe(400);
    expect(await rejected.json()).toEqual(
      Schema.encodeSync(InvalidRequest)(
        new InvalidRequest({ message: "The request does not match the action's input." }),
      ),
    );
  });

  it("splits MCP access by endpoint, since middleware covers every tool of one", async () => {
    const tools = await withMcpClient(
      {
        versionNegotiation: { mode: { pin: "2026-07-28" } },
        fetch: app.handler,
        path: "/mcp/public",
      },
      (client) => client.listTools(),
    );

    expect(tools.tools.map((item) => item.name)).toEqual(["status"]);

    const status = await withMcpClient(
      {
        versionNegotiation: { mode: { pin: "2026-07-28" } },
        fetch: app.handler,
        path: "/mcp/public",
      },
      (client) => client.callTool({ name: "status", arguments: {} }),
    );

    expect(status.structuredContent).toEqual({ value: { service: "effect-actions", users: 2 } });

    const anonymous = await app.handler(
      mcpRequest({ url: `http://localhost${testMcpPath}`, method: "tools/list" }),
    );

    expect(anonymous.status).toBe(401);
    expect(
      (await withMcp((client) => client.listTools())).tools.map((item) => item.name),
    ).not.toContain("status");
  });

  it("serves an MCP-only group as tools, sharing state with the HTTP groups", async () => {
    expect((await app.handler(request("/api/actions/audit/listChanges", "alice", {}))).status).toBe(
      404,
    );
    await app.handler(
      request("/api/actions/users/renameUser", "alice", { id: "1", name: "Augusta" }),
    );

    const changes = await tool("list_changes", {});
    expect(changes.structuredContent).toEqual({
      value: { changes: [{ actorId: "alice", userId: "1", name: "Augusta" }] },
    });
    expect((await tool("list_changes", {}, "bob")).structuredContent).toEqual({
      value: { changes: [] },
    });
  });
});

it("supplies the native request context to handlers without a router requirement", async () => {
  const group = ActionGroup.make(
    { name: "context" },
    Action.make("client", {
      description: "The connected client's declared name",
      success: Schema.String,
      mcp: { readOnly: true },
    }),
  );

  const app = group.implement({
    client: () =>
      Effect.map(McpSchema.McpRequestContext, (context) => context.clientInfo?.name ?? "anonymous"),
  });

  const web = HttpRouter.toWebHandler(
    ActionMcp.layerHttp(
      { protocols: [McpProtocol.v2026_07_28], name: "test", version: "0", path: "/mcp" },
      app,
    ).pipe(Layer.provide(HttpServer.layerServices)),
    { disableLogger: true },
  );

  onTestFinished(() => web.dispose());

  const result = Schema.decodeUnknownSync(
    Schema.Struct({ result: Schema.Struct({ structuredContent: Schema.Json }) }),
  )(
    await (
      await web.handler(
        mcpRequest({
          url: "http://localhost/mcp",
          method: "tools/call",
          params: { name: "client", arguments: {} },
        }),
      )
    ).json(),
  );

  expect(result.result.structuredContent).toEqual({ value: "test" });
});
