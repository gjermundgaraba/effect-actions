import { describe, expect, it } from "vite-plus/test";
import { Context, Effect, Layer, Schema } from "effect";
import {
  HttpClient,
  HttpClientRequest,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http";
import { layer as host } from "../examples/app.js";
import { Http } from "../examples/binding.js";
import { UserNotFound } from "../examples/contracts.js";
import * as Action from "../src/Action.js";
import * as ActionHttp from "../src/ActionHttp.js";
import * as ActionHttpClient from "../src/ActionHttpClient.js";
import * as ActionMcp from "../src/ActionMcp.js";
import { mcpRequest } from "../src/internal/mcp-request.js";
import * as Testing from "../src/Testing.js";

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

/** Run `program` against the example host, answered in memory with fresh example state. */
const againstHost = <A, E>(program: Effect.Effect<A, E, HttpClient.HttpClient>) =>
  program.pipe(Effect.provide(Testing.layer(host)), Effect.runPromise);

type Arguments = NonNullable<Parameters<typeof Testing.mcpCall>[0]["arguments"]>;

/** One tool call to the example host's `/mcp`, as the actor `token` names. */
const call = (name: string, input?: Arguments, token = "alice") =>
  Testing.mcpCall({
    name,
    ...(input === undefined ? {} : { arguments: input }),
    headers: { authorization: `Bearer ${token}` },
  });

describe("mcpCall", () => {
  it("returns a success without the `{ value }` envelope", async () => {
    const results = await againstHost(
      Effect.all([call("getUser", { id: "1" }), call("double", { value: "21" }), call("whoAmI")]),
    );

    expect(results).toEqual([
      { isError: false, value: { id: "1", name: "Ada" } },
      { isError: false, value: 42 },
      { isError: false, value: { id: "alice", tenantId: "acme" } },
    ]);
  });

  it("returns a declared or refused error as its decoded JSON", async () => {
    const results = await againstHost(
      Effect.all([
        call("getUser", { id: "404" }),
        call("renameUser", { id: "1", name: "Grace" }, "reader"),
      ]),
    );

    expect(results).toEqual([
      { isError: true, error: Schema.encodeSync(UserNotFound)(new UserNotFound({ id: "404" })) },
      {
        isError: true,
        error: Schema.encodeSync(Action.Forbidden)(
          new Action.Forbidden({ message: "Requires users:write." }),
        ),
      },
    ]);
  });

  it("returns the native message of an error that is not JSON", async () => {
    const result = await againstHost(call("getUser", { id: 1 }));

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

    const routes = ActionMcp.layerHttp(
      Action.implement(Fail, () => Effect.fail("failure")),
      { name: "test", version: "0" },
    );

    const result = await Testing.mcpCall({ name: "fail" }).pipe(
      Effect.provide(Testing.layer(routes)),
      Effect.runPromise,
    );

    expect(result).toEqual({ isError: true, error: "failure" });
  });

  it("fails with the status and body of an answer that is not a tool result", async () => {
    const [refused, missing] = await againstHost(
      Effect.all([
        Effect.flip(call("getUser", { id: "1" }, "nobody")),
        Effect.flip(call("missing_tool", {})),
      ]),
    );

    expect(refused).toBeInstanceOf(Error);
    expect(refused.message).toContain('MCP tools/call "getUser" answered 401');
    expect(refused.message).toContain(
      '{"_tag":"Unauthenticated","message":"A demo bearer token is required."}',
    );
    expect(missing.message).toContain('MCP tools/call "missing_tool"');
  });

  it("calls the endpoint its path names", async () => {
    // The example's public endpoint needs no credentials.
    const result = await againstHost(Testing.mcpCall({ name: "status", path: "/mcp/public" }));

    expect(result).toEqual({ isError: false, value: { service: "effect-actions", users: 2 } });
  });

  it("reads the reply from an event stream that carries notifications first", async () => {
    const stream = [
      { jsonrpc: "2.0", method: "notifications/message", params: { level: "info", data: "x" } },
      { jsonrpc: "2.0", id: 1, result: { content: [], structuredContent: { value: [1, 2] } } },
    ]
      .map((message) => `data: ${JSON.stringify(message)}\n\n`)
      .join("");

    const routes = HttpRouter.add(
      "POST",
      "/events",
      HttpServerResponse.text(stream, { contentType: "text/event-stream" }),
    );

    const result = await Testing.mcpCall({ name: "listed", path: "/events" }).pipe(
      Effect.provide(Testing.layer(routes)),
      Effect.runPromise,
    );

    expect(result).toEqual({ isError: false, value: [1, 2] });
  });
});

describe("layer", () => {
  class Visits extends Context.Service<Visits, { count: number }>()("testing/Visits") {}

  it("answers a client made without a base URL, and every tool call, in memory", async () => {
    const result = await againstHost(
      Effect.gen(function* () {
        const client = yield* ActionHttpClient.make(Http, {
          transformClient: HttpClient.mapRequest(HttpClientRequest.bearerToken("alice")),
        });

        return {
          user: yield* client.getUser({ id: "1" }),
          missing: yield* Effect.flip(client.getUser({ id: "404" })),
          status: yield* client.status(),
          doubled: yield* call("double", { value: "2" }),
        };
      }),
    );

    expect(result.user).toEqual({ id: "1", name: "Ada" });
    expect(result.missing).toEqual(new UserNotFound({ id: "404" }));
    expect(result.status).toEqual({ service: "effect-actions", users: 2 });
    expect(result.doubled).toEqual({ isError: false, value: 4 });
  });

  it("resolves a relative URL against http://localhost, and answers any origin in memory", async () => {
    const routes = HttpRouter.add(
      "GET",
      "/where",
      Effect.map(HttpServerRequest.HttpServerRequest, (request) =>
        HttpServerResponse.text(request.originalUrl),
      ),
    );

    const urls = await Effect.forEach(
      ["/where", "http://localhost/where", "https://api.example/where"],
      (url) => Effect.flatMap(HttpClient.get(url), (response) => response.text),
    ).pipe(Effect.provide(Testing.layer(routes)), Effect.runPromise);

    expect(urls).toEqual([
      "http://localhost/where",
      "http://localhost/where",
      "https://api.example/where",
    ]);
  });

  it("serves routes with the services their middleware provides, until its scope closes", async () => {
    const visits = { count: 0 };
    let released = false;

    const routes = Layer.merge(
      HttpRouter.add(
        "GET",
        "/visits",
        Effect.map(Visits, (seen) => HttpServerResponse.text(String(++seen.count))),
      ).pipe(HttpRouter.provideRequest(Layer.succeed(Visits, visits))),
      Layer.effectDiscard(Effect.addFinalizer(() => Effect.sync(() => (released = true)))),
    );

    const [visited, missing] = await Effect.gen(function* () {
      const response = yield* HttpClient.get("/visits");
      const visited = [response.status, yield* response.text, released] as const;

      return [visited, (yield* HttpClient.get("/missing")).status] as const;
    }).pipe(Effect.provide(Testing.layer(routes)), Effect.runPromise);

    expect(visited).toEqual([200, "1", false]);
    expect(missing).toBe(404);
    expect(visits.count).toBe(1);
    expect(released).toBe(true);
  });

  it("fails with the routes' build failure", async () => {
    class Unavailable extends Schema.TaggedError<Unavailable>()("Unavailable", {}) {}

    const Ping = Action.make("ping", {
      description: "Ping",
      access: "read",
      success: Schema.Boolean,
    });

    // The builder fails, so the routes are never built.
    const routes = ActionHttp.layer(
      ActionHttp.make([Ping]),
      Action.implement(
        Ping,
        Effect.gen(function* () {
          yield* new Unavailable();

          return () => Effect.succeed(true);
        }),
      ),
    );

    const failure = await HttpClient.get("/api/ping").pipe(
      Effect.provide(Testing.layer(routes)),
      Effect.flip,
      Effect.runPromise,
    );

    expect(failure).toEqual(new Unavailable());
  });

  it("refuses routes that still need a per-request service", () => {
    const needsVisits = HttpRouter.add(
      "GET",
      "/visits",
      Effect.map(Visits, ({ count }) => HttpServerResponse.text(String(count))),
    );

    const check = () => {
      // @ts-expect-error -- Nothing provides `Visits`, so the routes cannot be served.
      Testing.layer(needsVisits);
    };

    void check;
  });
});
