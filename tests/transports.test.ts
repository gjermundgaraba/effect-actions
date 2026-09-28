import { beforeEach, describe, expect, it } from "vite-plus/test";
import { type Client, InsufficientScopeError } from "@modelcontextprotocol/client";
import { Context, Effect, Layer, Schema } from "effect";
import { McpSchema } from "effect/ai";
import { HttpClient, HttpClientRequest, HttpServerRequest, HttpServerResponse } from "effect/http";
import { OpenApi } from "effect/http-api";
import * as Action from "../src/Action.js";
import * as ActionMcp from "../src/ActionMcp.js";
import * as Authentication from "../src/Authentication.js";
import { makeTestApp } from "./server.js";
import { Http } from "../examples/binding.js";
import { UserNotFound } from "../examples/contracts.js";
import { httpClient, serve } from "./serve.js";
import { mcpRequest } from "./requests.js";
import { withMcpClient } from "./mcp-client.js";

let app: ReturnType<typeof makeTestApp>;

/** The example's 401 challenge: the scope a first login requests and its metadata URL. */
const challenge =
  'Bearer scope="users:read", resource_metadata="http://localhost:3000/.well-known/oauth-protected-resource/mcp"';

beforeEach(() => {
  app = makeTestApp();
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
      fetch: authenticatedFetch(token),
    },
    run,
  );

const tool = (name: string, args: Schema.JsonObject, token = "alice") =>
  withMcp((client) => client.callTool({ name, arguments: args }), token);

describe("one implementation, both transports", () => {
  it("exposes schemas and renamed MCP tools from the same contracts", async () => {
    const reply = await withMcp((client) => client.listTools());
    expect(reply.tools.map((tool) => tool.name)).toEqual([
      "getUser",
      "renameUser",
      "whoAmI",
      "double",
      "listChanges",
    ]);
    const double = reply.tools.find((tool) => tool.name === "double");
    expect(double?.inputSchema.properties).toEqual({ value: { type: "string" } });
    expect(double?.outputSchema?.properties).toEqual({ value: { type: "number" } });
  });

  it("decodes input transforms on both transports; MCP wraps results as { value }", async () => {
    const http = await app.handler(request("/api/double", "alice", { value: "21" }));
    expect(await http.json()).toBe(42);
    const reply = await tool("double", { value: "21" });
    expect(reply.isError).toBe(false);
    expect(reply.structuredContent).toEqual({ value: 42 });
  });

  it("a write through MCP is immediately visible through HTTP", async () => {
    const reply = await tool("renameUser", { id: "1", name: "Lovelace" });
    expect(reply.isError).toBe(false);
    const response = await app.handler(request("/api/getUser", "alice", { id: "1" }));
    expect(await response.json()).toEqual({ id: "1", name: "Lovelace" });
    const other = await app.handler(request("/api/getUser", "bob", { id: "1" }));
    expect(await other.json()).toEqual({ id: "1", name: "Grace" });
  });

  it("serves domain errors structured over HTTP and as text over MCP", async () => {
    const http = await app.handler(request("/api/getUser", "alice", { id: "missing" }));

    expect(http.status).toBe(404);
    const body = await http.json();
    expect(body).toEqual(Schema.encodeSync(UserNotFound)(new UserNotFound({ id: "missing" })));
    const reply = await tool("getUser", { id: "missing" });
    expect(reply.isError).toBe(true);
    expect(reply.structuredContent).toBeUndefined();
    // UserNotFound has no message field, so the text is its encoding.
    expect(reply.content).toEqual([{ type: "text", text: JSON.stringify(body) }]);
  });

  it("rejects malformed input with each protocol's native error", async () => {
    const invalid = await app.handler(request("/api/double", "alice", { value: "nope" }));
    expect(invalid.status).toBe(400);
    expect(Schema.decodeUnknownSync(Action.InvalidInput)(await invalid.json()).message).toContain(
      'at ["value"]',
    );
    expect(await tool("double", { value: "nope" })).toMatchObject({ isError: true });
    expect(
      (await app.handler(request("/api/renameUser", "alice", { id: "1", name: "" }))).status,
    ).toBe(400);
  });

  it("the host's authorization runs on every call; discovery is not filtered per actor", async () => {
    // Native McpServer registers tools once, so tools/list is the same for every actor.
    const reply = await withMcp((client) => client.listTools(), "reader");
    expect(reply.tools.map((tool) => tool.name)).toContain("renameUser");

    // The refusal names the scope it lacks, so the official client, which cannot
    // re-authorize here, reports the step-up it would take.
    const denied = tool("renameUser", { id: "1", name: "unauthorized" }, "reader");

    await expect(denied).rejects.toBeInstanceOf(InsufficientScopeError);
    await expect(denied).rejects.toMatchObject({
      requiredScope: "users:write",
      resourceMetadataUrl: new URL(
        "http://localhost:3000/.well-known/oauth-protected-resource/mcp",
      ),
      errorDescription: "Requires users:write.",
    });

    const forbiddenBody = Schema.encodeSync(Action.Forbidden)(
      new Action.Forbidden({ message: "Requires users:write.", scopes: ["users:write"] }),
    );

    const forbidden = await app.handler(
      request("/api/renameUser", "reader", { id: "1", name: "unauthorized" }),
    );

    expect(forbidden.status).toBe(403);
    expect(forbidden.headers.get("www-authenticate")).toBe(
      'Bearer error="insufficient_scope", scope="users:write", resource_metadata="http://localhost:3000/.well-known/oauth-protected-resource/mcp", error_description="Requires users:write."',
    );
    expect(await forbidden.json()).toEqual(forbiddenBody);
    expect(await (await app.handler(request("/api/getUser", "alice", { id: "1" }))).json()).toEqual(
      {
        id: "1",
        name: "Ada",
      },
    );
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
    // MCP tools are strict: undeclared arguments are refused rather than stripped.
    expect((await tool("getUser", args)).isError).toBe(true);

    const spoof = await withMcp((client) =>
      client.callTool({
        name: "getUser",
        arguments: { id: "1" },
        _meta: { actor: { id: "bob", tenantId: "other" } },
      }),
    );

    expect(spoof.structuredContent).toEqual({ value: { id: "1", name: "Ada" } });
  });

  it("keeps concurrent request actors isolated over HTTP", async () => {
    const tokens = Array.from({ length: 20 }, (_, index) => (index % 2 === 0 ? "alice" : "bob"));

    const responses = await Promise.all(
      tokens.map(async (token) => (await app.handler(request("/api/whoAmI", token, {}))).json()),
    );

    expect(responses).toEqual(
      tokens.map((id) => ({ id, tenantId: id === "alice" ? "acme" : "other" })),
    );
  });

  it("authenticates both transports before execution", async () => {
    for (const path of ["/api/getUser", "/mcp"]) {
      const response = await app.handler(
        new Request(`http://localhost${path}`, { method: "POST" }),
      );

      expect(response.status).toBe(401);
      // The example authenticates as an OAuth protected resource, named in its challenge.
      expect(response.headers.get("www-authenticate")).toBe(challenge);
      expect(await response.json()).toEqual(
        Schema.encodeSync(Action.Unauthenticated)(
          new Action.Unauthenticated({ message: "A bearer token is required." }),
        ),
      );
    }

    expect((await app.handler(request("/api/getUser", "toString", { id: "1" }))).status).toBe(401);
  });

  it("rejects untrusted hosts and browser origins in the example host", async () => {
    const foreign = new Request("http://evil.example/api/getUser", {
      method: "POST",
      headers: { authorization: "Bearer alice" },
    });

    expect((await app.handler(foreign)).status).toBe(403);

    // The policy is the host's outermost layer, so it covers the credential-free group too.
    const foreignPublic = new Request(
      "http://attacker.example/api/status",
      anonymous("/api/status", {}),
    );

    expect((await app.handler(foreignPublic)).status).toBe(403);
    const crossOrigin = request("/api/getUser", "alice", { id: "1" });
    crossOrigin.headers.set("origin", "https://evil.example");
    expect((await app.handler(crossOrigin)).status).toBe(403);
  });

  it("uses the documented HTTP input error statuses", async () => {
    const malformed = new Request(request("/api/double", "alice", {}), {
      method: "POST",
      body: "{",
    });

    const wrongType = request("/api/double", "alice", {});
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
      await (await app.handler(request("/api/openapi.json"))).json(),
    );

    expect(document.openapi).toBe("3.1.0");
    expect(Object.keys(document.paths)).toEqual([
      "/api/status",
      "/api/getUser",
      "/api/renameUser",
      "/api/double",
      "/api/whoAmI",
    ]);
    expect(document.paths["/api/getUser"]).toMatchObject({
      post: {
        operationId: "getUser",
        tags: ["api"],
        requestBody: {
          content: { "application/json": { schema: { properties: { id: { type: "string" } } } } },
        },
        responses: { "200": {} },
      },
    });

    // Every declared error has its status: the action's own, and the built-in ones.
    expect(
      Object.keys(OpenApi.fromApi(Http.api).paths["/api/getUser"]?.post?.responses ?? {}).sort(),
    ).toEqual(["200", "400", "401", "403", "404"]);

    expect(document.paths["/api/double"]).toMatchObject({
      post: {
        requestBody: {
          content: {
            "application/json": { schema: { properties: { value: { type: "string" } } } },
          },
        },
      },
    });

    const doubleOperation = OpenApi.fromApi(Http.api).paths?.["/api/double"]?.post;

    expect(doubleOperation?.operationId).toBe("double");
    expect(doubleOperation?.responses).not.toHaveProperty("404");
  });
});

describe("actions under their own middleware", () => {
  it("serves status and the document without credentials, the user actions only with them", async () => {
    const status = await app.handler(anonymous("/api/status", {}));
    expect(status.status).toBe(200);
    expect(await status.json()).toEqual({ service: "effect-actions", users: 2 });

    const document = await app.handler(anonymous("/api/openapi.json"));
    expect(document.status).toBe(200);
    expect(await document.json()).toEqual(OpenApi.fromApi(Http.api));

    const unauthenticated = await app.handler(anonymous("/api/whoAmI", {}));
    expect(unauthenticated.status).toBe(401);
    expect(unauthenticated.headers.get("www-authenticate")).toBe(challenge);
    expect((await app.handler(request("/api/whoAmI", "alice", {}))).status).toBe(200);
  });

  it("calls every action through one flat client, which decodes the built-in refusals", async () => {
    const as = (token?: string) =>
      httpClient(
        Http,
        app.handler,
        token === undefined
          ? {}
          : { transformClient: HttpClient.mapRequest(HttpClientRequest.bearerToken(token)) },
      );

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* as("alice");

        return {
          status: yield* client.status(),
          identity: yield* client.whoAmI(),
          // The authentication middleware's 401 and the hook's 403, as typed failures.
          unauthenticated: yield* Effect.flip((yield* as()).whoAmI()),
          forbidden: yield* Effect.flip(
            (yield* as("reader")).renameUser({ id: "1", name: "Reader" }),
          ),
        };
      }),
    );

    expect(result.status.users).toBe(2);
    expect(result.identity).toEqual({ id: "alice", tenantId: "acme" });
    expect(result.unauthenticated).toBeInstanceOf(Action.Unauthenticated);
    expect(result.unauthenticated).toMatchObject({ message: "A bearer token is required." });
    expect(result.forbidden).toBeInstanceOf(Action.Forbidden);
    expect(result.forbidden).toMatchObject({ message: "Requires users:write." });
  });

  it("splits MCP access by endpoint, since middleware covers every tool of one", async () => {
    const tools = await withMcpClient(
      {
        fetch: app.handler,
        path: "/mcp/public",
      },
      (client) => client.listTools(),
    );

    expect(tools.tools.map((item) => item.name)).toEqual(["status"]);

    const status = await withMcpClient(
      {
        fetch: app.handler,
        path: "/mcp/public",
      },
      (client) => client.callTool({ name: "status", arguments: {} }),
    );

    expect(status.structuredContent).toEqual({ value: { service: "effect-actions", users: 2 } });

    const anonymous = await app.handler(mcpRequest({ method: "tools/list" }));

    expect(anonymous.status).toBe(401);
    expect(
      (await withMcp((client) => client.listTools())).tools.map((item) => item.name),
    ).not.toContain("status");
  });

  it("serves an MCP-only action as a tool, sharing state with the HTTP actions", async () => {
    expect((await app.handler(request("/api/listChanges", "alice", {}))).status).toBe(404);
    await app.handler(request("/api/renameUser", "alice", { id: "1", name: "Augusta" }));

    const changes = await tool("listChanges", {});
    expect(changes.structuredContent).toEqual({
      value: { changes: [{ actorId: "alice", userId: "1", name: "Augusta" }] },
    });
    expect((await tool("listChanges", {}, "bob")).structuredContent).toEqual({
      value: { changes: [] },
    });
  });
});

it("refuses a browser Origin on an MCP endpoint unless the endpoint lists it", async () => {
  const Ping = Action.make("ping", {
    description: "Answer the caller",
    access: "read",
    success: Schema.String,
  });

  const app = Action.implement(Ping, () => Effect.succeed("pong"));

  const serveMcp = (allowedOrigins?: ReadonlyArray<string>) => {
    const web = serve(
      ActionMcp.layerHttp(app, {
        name: "test",
        version: "0",
        ...(allowedOrigins === undefined ? {} : { allowedOrigins }),
      }),
    );

    return web.handler;
  };

  const list = (origin?: string) =>
    mcpRequest({
      method: "tools/list",
      headers: origin === undefined ? undefined : { origin },
    });

  // Without `allowedOrigins` the native server admits Origin-less clients
  // and answers Origin-bearing requests that reach it with 403.
  const closed = serveMcp();
  expect((await closed(list())).status).toBe(200);
  expect((await closed(list("http://localhost:3000"))).status).toBe(403);

  // The exact allowlist admits the request, but does not supply browser CORS.
  const open = serveMcp(["http://localhost:3000"]);
  const allowed = await open(list("http://localhost:3000"));
  expect(allowed.status).toBe(200);
  expect(allowed.headers.get("access-control-allow-origin")).toBeNull();
  expect((await open(list("http://localhost:4000"))).status).toBe(403);

  const preflight = await open(
    new Request("http://localhost/mcp", {
      method: "OPTIONS",
      headers: {
        origin: "http://localhost:3000",
        "access-control-request-method": "POST",
        "access-control-request-headers": "content-type,mcp-protocol-version",
      },
    }),
  );

  expect(preflight.status).toBe(405);
  expect(preflight.headers.get("access-control-allow-origin")).toBeNull();
});

it("runs wrapping authentication before the native MCP Origin check", async () => {
  class Identity extends Context.Service<Identity, string>()("origin/Identity") {}

  let authentications = 0;

  const authentication = Authentication.make(
    Identity,
    Effect.gen(function* () {
      authentications++;
      const request = yield* HttpServerRequest.HttpServerRequest;

      if (request.headers.authorization !== "Bearer accepted") {
        return yield* Effect.fail(HttpServerResponse.empty({ status: 401 }));
      }

      return "caller";
    }),
  );

  const web = serve(
    ActionMcp.layerHttp([], {
      name: "origin-order",
      version: "0",
      allowedOrigins: ["https://allowed.example"],
    }).pipe(Layer.provide(authentication)),
  );

  const rejected = await web.handler(
    mcpRequest({
      method: "tools/list",
      headers: { origin: "https://disallowed.example" },
    }),
  );

  expect(rejected.status).toBe(401);
  expect(authentications).toBe(1);

  const authenticated = await web.handler(
    mcpRequest({
      method: "tools/list",
      headers: { origin: "https://disallowed.example", authorization: "Bearer accepted" },
    }),
  );

  expect(authenticated.status).toBe(403);
  expect(authentications).toBe(2);
});

it("supplies the native request context to handlers without a router requirement, at the default /mcp path", async () => {
  const ClientName = Action.make("client", {
    description: "The connected client's declared name",
    access: "write",
    success: Schema.String,
  });

  const app = Action.implement(ClientName, () =>
    Effect.map(McpSchema.McpRequestContext, (context) => context.clientInfo?.name ?? "anonymous"),
  );

  // No `path`: the endpoint is served at `/mcp`.
  const web = serve(ActionMcp.layerHttp(app, { name: "test", version: "0" }));

  const result = Schema.decodeUnknownSync(
    Schema.Struct({ result: Schema.Struct({ structuredContent: Schema.Json }) }),
  )(
    await (
      await web.handler(
        mcpRequest({
          method: "tools/call",
          params: {
            name: "client",
            arguments: {},
            _meta: { "io.modelcontextprotocol/clientInfo": { name: "probe", version: "0" } },
          },
        }),
      )
    ).json(),
  );

  expect(result.result.structuredContent).toEqual({ value: "probe" });
});
