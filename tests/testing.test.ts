import { describe, expect, it } from "vite-plus/test";
import { Context, Effect, Layer, Schema } from "effect";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientError,
  HttpClientRequest,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http";
import { layer as host } from "../examples/app.js";
import { Http } from "../examples/binding.js";
import {
  Double,
  GetUser,
  RenameUser,
  Status,
  UserNotFound,
  WhoAmI,
} from "../examples/contracts.js";
import * as Action from "../src/Action.js";
import * as ActionHttp from "../src/ActionHttp.js";
import * as ActionMcp from "../src/ActionMcp.js";
import * as Testing from "../src/Testing.js";

/** Run `program` against the example host, answered in memory with fresh example state. */
const againstHost = <A, E>(program: Effect.Effect<A, E, HttpClient.HttpClient>) =>
  program.pipe(Effect.provide(Testing.layer(host)), Effect.runPromise);

/** Headers carrying `token`, a demo actor's name, as its bearer token. */
const as = (token = "alice") => ({ headers: { authorization: `Bearer ${token}` } });

describe("mcpCall", () => {
  it("encodes the input and decodes the success, without the `{ value }` envelope", async () => {
    const results = await againstHost(
      Effect.all([
        Testing.mcpCall(GetUser, { id: "1" }, as()),
        // Decoded input: `Double` encodes its number as a string on the wire.
        Testing.mcpCall(Double, { value: 21 }, as()),
        Testing.mcpCall(WhoAmI, {}, as()),
      ]),
    );

    expect(results).toEqual([{ id: "1", name: "Ada" }, 42, { id: "alice", tenantId: "acme" }]);
  });

  it("fails with a declared error or a refusal as its decoded value", async () => {
    const results = await againstHost(
      Effect.all([
        Effect.flip(Testing.mcpCall(GetUser, { id: "404" }, as())),
        Effect.flip(Testing.mcpCall(RenameUser, { id: "1", name: "Grace" }, as("reader"))),
        // The endpoint's authentication answers before any tool, with the same JSON.
        Effect.flip(Testing.mcpCall(GetUser, { id: "1" }, as("nobody"))),
      ]),
    );

    expect(results).toEqual([
      new UserNotFound({ id: "404" }),
      new Action.Forbidden({ message: "Requires users:write." }),
      new Action.Unauthenticated({ message: "Unknown demo token." }),
    ]);
  });

  it("decodes a declared error of any shape, a string included", async () => {
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

    const result = await Testing.mcpCall(Fail).pipe(
      Effect.flip,
      Effect.provide(Testing.layer(routes)),
      Effect.runPromise,
    );

    expect(result).toBe("failure");

    // A tool's error is a tool result: in any other answer's body, it is that answer.
    const other = await Testing.mcpCall(Fail, {}, { url: "/broken" }).pipe(
      Effect.flip,
      Effect.provide(
        Testing.layer(
          HttpRouter.add("POST", "/broken", HttpServerResponse.text('"failure"', { status: 500 })),
        ),
      ),
      Effect.runPromise,
    );

    expect(String(other)).toContain('answered 500: "failure"');
  });

  it("returns nothing for an action that returns nothing, over HTTP and MCP alike", async () => {
    const Reset = Action.make("reset", { description: "Reset", access: "write" });
    const Http = ActionHttp.make([Reset]);
    const reset = Action.implement(Reset, () => Effect.void);

    const routes = Layer.mergeAll(
      ActionHttp.layer(Http, reset),
      ActionMcp.layerHttp(reset, { name: "test", version: "0" }),
    );

    const results = await Effect.gen(function* () {
      const client = yield* ActionHttp.client(Http);

      return [yield* client.reset(), yield* Testing.mcpCall(Reset)];
    }).pipe(Effect.provide(Testing.layer(routes)), Effect.runPromise);

    expect(results).toEqual([undefined, undefined]);
  });

  it("fails with an Error holding any other answer", async () => {
    // Contracts the host does not serve as declared here: other input, and no such tool.
    const Loose = Action.make("getUser", {
      description: "The host's getUser, with an input it refuses",
      access: "read",
      input: { id: Schema.Finite },
      success: Schema.String,
    });

    const Missing = Action.make("missing_tool", {
      description: "Not served",
      access: "read",
      success: Schema.String,
    });

    const [invalid, missing, nowhere] = await againstHost(
      Effect.all([
        Effect.flip(Testing.mcpCall(Loose, { id: 1 }, as())),
        Effect.flip(Testing.mcpCall(Missing, {}, as())),
        Effect.flip(Testing.mcpCall(Missing, {}, { url: "/nowhere" })),
      ]),
    );

    expect(String(invalid)).toContain("Invalid parameters for tool 'getUser'");
    expect(String(missing)).toContain('MCP tools/call "missing_tool" failed with');
    expect(String(nowhere)).toContain('MCP tools/call "missing_tool" answered 404');
  });

  it("calls the endpoint its url names", async () => {
    // The example's public endpoint needs no credentials.
    const result = await againstHost(Testing.mcpCall(Status, {}, { url: "/mcp/public" }));

    expect(result).toEqual({ service: "effect-actions", users: 2 });
  });

  it("resolves a relative url only under layer", async () => {
    const failure = await Testing.mcpCall(Status).pipe(
      Effect.flip,
      Effect.provide(FetchHttpClient.layer),
      Effect.runPromise,
    );

    expect(HttpClientError.isHttpClientError(failure) && failure.reason._tag).toBe(
      "InvalidUrlError",
    );
  });

  const Listed = Action.make("listed", {
    description: "Lists numbers",
    access: "read",
    success: Schema.Array(Schema.Finite),
  });

  const reply = {
    jsonrpc: "2.0",
    id: 1,
    result: { content: [], structuredContent: { value: [1, 2] } },
  };

  /** `Listed` against a route answering `body` with `contentType`. */
  const listed = (body: string, contentType: string) =>
    Testing.mcpCall(Listed, {}, { url: "/events" }).pipe(
      Effect.provide(
        Testing.layer(
          HttpRouter.add("POST", "/events", HttpServerResponse.text(body, { contentType })),
        ),
      ),
      Effect.runPromise,
    );

  it("reads the reply from an event stream that carries notifications first", async () => {
    const stream = [
      { jsonrpc: "2.0", method: "notifications/message", params: { level: "info", data: "x" } },
      reply,
    ]
      .map((message) => `data: ${JSON.stringify(message)}\n\n`)
      .join("");

    expect(await listed(stream, "text/event-stream")).toEqual([1, 2]);
  });

  it("reads a JSON reply however it is laid out", async () => {
    expect(await listed(JSON.stringify(reply, null, 2), "application/json")).toEqual([1, 2]);
  });
});

describe("layer", () => {
  class Visits extends Context.Service<Visits, { count: number }>()("testing/Visits") {}

  it("answers a client made without a base URL, and every tool call, in memory", async () => {
    const result = await againstHost(
      Effect.gen(function* () {
        const client = yield* ActionHttp.client(Http, {
          transformClient: HttpClient.mapRequest(HttpClientRequest.bearerToken("alice")),
        });

        return {
          user: yield* client.getUser({ id: "1" }),
          missing: yield* Effect.flip(client.getUser({ id: "404" })),
          status: yield* client.status(),
          doubled: yield* Testing.mcpCall(Double, { value: 2 }, as()),
        };
      }),
    );

    expect(result.user).toEqual({ id: "1", name: "Ada" });
    expect(result.missing).toEqual(new UserNotFound({ id: "404" }));
    expect(result.status).toEqual({ service: "effect-actions", users: 2 });
    expect(result.doubled).toBe(4);
  });

  it("resolves a relative URL against http://localhost, and answers any origin in memory", async () => {
    const routes = HttpRouter.add(
      "GET",
      "/where",
      Effect.map(HttpServerRequest.HttpServerRequest, (request) =>
        HttpServerResponse.text(request.originalUrl),
      ),
    );

    const get = (url: string) => Effect.flatMap(HttpClient.get(url), (response) => response.text);

    const urls = await Effect.all([
      ...["/where", "http://localhost/where", "https://api.example/where"].map(get),
      // A client's own base URL is applied first: only a URL still relative is resolved.
      get("/where").pipe(
        Effect.provideServiceEffect(
          HttpClient.HttpClient,
          Effect.map(
            HttpClient.HttpClient,
            HttpClient.mapRequest(HttpClientRequest.prependUrl("https://api.example")),
          ),
        ),
      ),
    ]).pipe(Effect.provide(Testing.layer(routes)), Effect.runPromise);

    expect(urls).toEqual([
      "http://localhost/where",
      "http://localhost/where",
      "https://api.example/where",
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
