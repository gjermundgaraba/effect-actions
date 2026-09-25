import { describe, expect, it, onTestFinished } from "vite-plus/test";
import { httpClient, mcpCall, serve as serveRoutes } from "../src/Testing.js";
import { mcpRequest } from "../src/internal/mcp-request.js";
import { makeTestApp, makeTestMcp } from "./server.js";
import { Forbidden } from "../examples/auth.js";
import { UserNotFound } from "../examples/contracts.js";
import { Context, Effect, Layer, Schema } from "effect";
import {
  HttpClient,
  HttpClientRequest,
  HttpRouter,
  HttpServerResponse,
} from "effect/unstable/http";
import { Http } from "../examples/binding.js";
import * as Action from "../src/Action.js";

it("sends to /mcp on http://localhost unless told otherwise", () => {
  expect(mcpRequest({ method: "tools/list" }).url).toBe("http://localhost/mcp");
  expect(mcpRequest({ method: "tools/list", path: "/mcp/public" }).url).toBe(
    "http://localhost/mcp/public",
  );
  expect(
    mcpRequest({ method: "tools/list", path: "/tools", baseUrl: "https://api.example" }).url,
  ).toBe("https://api.example/tools");
});

it("supplies consistent stateless protocol defaults", async () => {
  const request = mcpRequest({ method: "tools/list" });
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
    method: "tools/call",
    params: { name: "inspect", arguments: { owner, nested: [{ owner }] } },
  });

  expect(await request.json()).toMatchObject({
    params: { name: "inspect", arguments: { nested: [{}] } },
  });
});

it("preserves malformed tool names without inventing a routing header", async () => {
  const request = mcpRequest({
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
        name,
        ...(input === undefined ? {} : { arguments: input }),
        headers: { authorization: `Bearer ${token}` },
      });
  };

  it("returns a success without the `{ value }` envelope", async () => {
    const call = serve();

    expect(await call("getUser", { id: "1" })).toEqual({
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

    expect(await call("getUser", { id: "404" })).toEqual({
      isError: true,
      error: Schema.encodeSync(UserNotFound)(new UserNotFound({ id: "404" })),
    });
    expect(await call("renameUser", { id: "1", name: "Grace" }, "reader")).toEqual({
      isError: true,
      error: Schema.encodeSync(Forbidden)(new Forbidden({ permission: "users:write" })),
    });
  });

  it("returns the native message of an error that is not JSON", async () => {
    const call = serve();
    const result = await call("getUser", { id: 1 });

    expect(result.isError).toBe(true);
    expect(result.isError && result.error).toEqual(
      expect.stringContaining("Invalid parameters for tool 'getUser'"),
    );
  });

  it("returns a declared error of any shape as its decoded JSON, a string included", async () => {
    const Fail = Action.make("fail", {
      description: "Fails with a string",
      access: "write",
      success: Schema.String,
      errors: [Schema.String],
    });

    const web = makeTestMcp(
      Action.implement(Fail, () => Effect.fail("failure")),
      Layer.empty,
    );

    onTestFinished(() => web.dispose());

    expect(await mcpCall(web.handler, { name: "fail" })).toEqual({
      isError: true,
      error: "failure",
    });
  });

  it("throws for an answer that is not a tool result", async () => {
    const call = serve();

    await expect(call("getUser", { id: "1" }, "nobody")).rejects.toThrow(
      'MCP tools/call "getUser" answered 401',
    );
    await expect(call("missing_tool", {})).rejects.toThrow('MCP tools/call "missing_tool"');
  });

  it("calls the endpoint its path and base URL name", async () => {
    const urls: string[] = [];

    const reply = {
      jsonrpc: "2.0",
      id: 1,
      result: { content: [], structuredContent: { value: 1 } },
    };

    const handler = async (request: Request) => {
      urls.push(request.url);

      return Response.json(reply);
    };

    await mcpCall(handler, { name: "one" });
    await mcpCall(handler, { name: "one", path: "/mcp/public", baseUrl: "https://api.example" });

    expect(urls).toEqual(["http://localhost/mcp", "https://api.example/mcp/public"]);
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
      { name: "listed" },
    );

    expect(result).toEqual({ isError: false, value: [1, 2] });
  });
});

describe("httpClient", () => {
  it("calls a flat binding in memory through the flat client", async () => {
    const web = makeTestApp();
    onTestFinished(() => web.dispose());

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* httpClient(Http, web.handler, {
          transformClient: HttpClient.mapRequest(HttpClientRequest.bearerToken("alice")),
        });

        return {
          user: yield* client.getUser({ id: "1" }),
          missing: yield* Effect.flip(client.getUser({ id: "404" })),
          status: yield* client.status(),
        };
      }),
    );

    expect(result.user).toEqual({ id: "1", name: "Ada" });
    expect(result.missing).toEqual(new UserNotFound({ id: "404" }));
    expect(result.status.users).toBe(2);
  });
});

describe("serve", () => {
  class Visits extends Context.Service<Visits, { count: number }>()("testing/Visits") {}

  it("serves routes in memory with the platform services, until disposed", async () => {
    const visits = { count: 0 };

    const server = serveRoutes(
      HttpRouter.add(
        "GET",
        "/visits",
        Effect.map(Visits, (seen) => HttpServerResponse.text(String(++seen.count))),
      ).pipe(HttpRouter.provideRequest(Layer.succeed(Visits, visits))),
    );

    try {
      const response = await server.handler(new Request("http://localhost/visits"));

      expect(response.status).toBe(200);
      expect(await response.text()).toBe("1");
      expect((await server.handler(new Request("http://localhost/missing"))).status).toBe(404);
    } finally {
      await server.dispose();
    }

    expect(visits.count).toBe(1);
  });

  it("serves the example host for every in-memory helper, given the server itself", async () => {
    const { layer } = await import("../examples/app.js");
    const server = serveRoutes(layer);
    onTestFinished(() => server.dispose());

    const status = await Effect.runPromise(
      Effect.flatMap(httpClient(Http, server), (client) => client.status()),
    );

    expect(status.service).toBe("effect-actions");
    expect(
      await mcpCall(server, {
        name: "double",
        arguments: { value: "2" },
        headers: { authorization: "Bearer alice" },
      }),
    ).toEqual({ isError: false, value: 4 });
  });

  it("refuses routes that still need a per-request service", () => {
    const needsVisits = HttpRouter.add(
      "GET",
      "/visits",
      Effect.map(Visits, ({ count }) => HttpServerResponse.text(String(count))),
    );

    const check = () => {
      // @ts-expect-error -- Nothing provides `Visits`, so the routes cannot be served.
      serveRoutes(needsVisits);
    };

    void check;
  });
});
