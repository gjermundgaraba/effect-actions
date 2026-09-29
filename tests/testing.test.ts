import { describe, expect, it } from "vite-plus/test";
import { Context, Effect, Layer, Schema, SchemaGetter } from "effect";
import { Command } from "effect/cli";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientError,
  HttpClientRequest,
  HttpClientResponse,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/http";
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
import * as ActionCli from "../src/ActionCli.js";
import * as ActionMcp from "../src/ActionMcp.js";
import * as Testing from "../src/Testing.js";
import { cliServices, logged } from "./cli-services.js";

/** Run `program` against the example host, answered in memory with fresh example state. */
const againstHost = <A, E>(program: Effect.Effect<A, E, HttpClient.HttpClient>) =>
  program.pipe(Effect.provide(Testing.layer(host)), Effect.runPromise);

/** Client options sending `token`, a demo actor's name, as its bearer token. */
const as = (token = "alice") => ({
  transformClient: HttpClient.mapRequest(HttpClientRequest.bearerToken(token)),
});

/** Headers carrying `token` as its bearer token, for a raw request. */
const headersAs = (token = "alice") => ({ headers: { authorization: `Bearer ${token}` } });

/** The example host's MCP client, as `token`'s actor. */
const mcpAs = (token?: string) =>
  Testing.mcpClient([GetUser, RenameUser, Double, WhoAmI], as(token));

describe("mcpClient", () => {
  it("encodes the input and decodes the success, without the `{ value }` envelope", async () => {
    const results = await againstHost(
      Effect.gen(function* () {
        const mcp = yield* mcpAs();

        return [
          yield* mcp.getUser({ id: "1" }),
          // Decoded input: `Double` encodes its number as a string on the wire.
          yield* mcp.double({ value: 21 }),
          yield* mcp.whoAmI(),
        ];
      }),
    );

    expect(results).toEqual([{ id: "1", name: "Ada" }, 42, { id: "alice", tenantId: "acme" }]);
  });

  it("fails with a declared error or a refusal as its decoded value", async () => {
    const results = await againstHost(
      Effect.gen(function* () {
        const alice = yield* mcpAs();
        const reader = yield* mcpAs("reader");
        const nobody = yield* mcpAs("nobody");

        return yield* Effect.all([
          Effect.flip(alice.getUser({ id: "404" })),
          Effect.flip(reader.renameUser({ id: "1", name: "Grace" })),
          // The endpoint's authentication answers before any tool, with the same JSON.
          Effect.flip(nobody.getUser({ id: "1" })),
        ]);
      }),
    );

    expect(results).toEqual([
      new UserNotFound({ id: "404" }),
      new Action.Forbidden({ message: "Requires users:write.", scopes: ["users:write"] }),
      new Action.Unauthenticated({ message: "Unknown demo token." }),
    ]);
  });

  it("decodes a built-in error a tool returns as its class", async () => {
    const Refuse = Action.make("refuse", { description: "Refuses", access: "write" });
    const Reject = Action.make("reject", { description: "Rejects its input", access: "write" });

    const app = Action.implement([Refuse, Reject], {
      refuse: () => Effect.fail(new Action.Forbidden({ message: "Never." })),
      reject: () => Effect.fail(new Action.InvalidInput({ message: "Out of range." })),
    });

    const results = await Effect.runPromise(
      Effect.gen(function* () {
        const mcp = yield* Testing.mcpClient([Refuse, Reject]);

        return yield* Effect.all([Effect.flip(mcp.refuse()), Effect.flip(mcp.reject())]);
      }).pipe(
        Effect.provide(Testing.layer(ActionMcp.layerHttp(app, { name: "test", version: "0" }))),
      ),
    );

    expect(results).toEqual([
      new Action.Forbidden({ message: "Never." }),
      new Action.InvalidInput({ message: "Out of range." }),
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

    const result = await Testing.mcpClient([Fail]).pipe(
      Effect.flatMap((mcp) => Effect.flip(mcp.fail())),
      Effect.provide(Testing.layer(routes)),
      Effect.runPromise,
    );

    expect(result).toBe("failure");

    // A tool's error is a tool result: in any other answer's body, it is that answer.
    const other = await Testing.mcpClient([Fail], { url: "/broken" }).pipe(
      Effect.flatMap((mcp) => Effect.flip(mcp.fail())),
      Effect.provide(
        Testing.layer(
          HttpRouter.add("POST", "/broken", HttpServerResponse.text('"failure"', { status: 500 })),
        ),
      ),
      Effect.runPromise,
    );

    expect(String(other)).toContain('answered 500: "failure"');
  });

  it("decodes a declared error whose schema decodes asynchronously", async () => {
    const Later = Schema.String.pipe(
      Schema.decodeTo(Schema.String, {
        decode: SchemaGetter.transformEffect((reason: string) =>
          Effect.as(Effect.sleep(1), reason),
        ),
        encode: SchemaGetter.passthrough(),
      }),
    );

    class Late extends Schema.TaggedError<Late>()("Late", { reason: Later }) {}

    const Slow = Action.make("slow", {
      description: "Fails late",
      access: "read",
      success: Schema.String,
      errors: [Late],
    });

    const routes = ActionMcp.layerHttp(
      Action.implement(Slow, () => Effect.fail(new Late({ reason: "busy" }))),
      { name: "test", version: "0" },
    );

    const failure = await Testing.mcpClient([Slow]).pipe(
      Effect.flatMap((mcp) => Effect.flip(mcp.slow())),
      Effect.provide(Testing.layer(routes)),
      Effect.runPromise,
    );

    expect(failure).toEqual(new Late({ reason: "busy" }));
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

      const mcp = yield* Testing.mcpClient([Reset]);

      return [yield* client.reset(), yield* mcp.reset()];
    }).pipe(Effect.provide(Testing.layer(routes)), Effect.runPromise);

    expect(results).toEqual([undefined, undefined]);
  });

  it("fails with an McpCallError holding any other answer", async () => {
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

    /** `Missing` called at `url`. */
    const missing = (url?: string) =>
      Effect.flatMap(
        Testing.mcpClient([Missing], { ...as(), ...(url === undefined ? {} : { url }) }),
        (mcp) => Effect.flip(mcp.missing_tool()),
      );

    const failures = await againstHost(
      Effect.all([
        Effect.flatMap(Testing.mcpClient([Loose], as()), (mcp) =>
          Effect.flip(mcp.getUser({ id: 1 })),
        ),
        missing(),
        missing("/nowhere"),
      ]),
    );

    // Answers no MCP server gives: no JSON-RPC reply, and a result without its structure.
    const odd = await Effect.all([missing("/garbled"), missing("/bare")]).pipe(
      Effect.provide(
        Testing.layer(
          Layer.mergeAll(
            HttpRouter.add("POST", "/garbled", HttpServerResponse.text("not json")),
            HttpRouter.add(
              "POST",
              "/bare",
              HttpServerResponse.jsonUnsafe({ jsonrpc: "2.0", id: 1, result: { content: [] } }),
            ),
          ),
        ),
      ),
      Effect.runPromise,
    );

    expect([...failures, ...odd].map((failure) => failure._tag)).toEqual(
      Array(5).fill("McpCallError"),
    );

    expect([...failures, ...odd].map(String)).toEqual([
      expect.stringContaining("Invalid parameters for tool 'getUser'"),
      expect.stringContaining('MCP tools/call "missing_tool" failed with'),
      expect.stringContaining('MCP tools/call "missing_tool" answered 404'),
      expect.stringContaining('MCP tools/call "missing_tool" had no reply: not json'),
      expect.stringContaining('MCP tools/call "missing_tool" returned no structured content'),
    ]);
  });

  it("calls the endpoint its url names", async () => {
    // The example's public endpoint needs no credentials.
    const result = await againstHost(
      Effect.flatMap(Testing.mcpClient([Status], { url: "/mcp/public" }), (mcp) => mcp.status()),
    );

    expect(result).toEqual({ service: "effect-actions", users: 2 });
  });

  it("resolves a relative url only under layer", async () => {
    const failure = await Testing.mcpClient([Status]).pipe(
      Effect.flatMap((mcp) => Effect.flip(mcp.status())),
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
    Effect.flatMap(Testing.mcpClient([Listed], { url: "/events" }), (mcp) => mcp.listed()).pipe(
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

  it("reads an event whose data spans several lines", async () => {
    const event = JSON.stringify(reply, null, 2)
      .split("\n")
      .map((line) => `data: ${line}\n`)
      .join("");

    expect(await listed(`${event}\n`, "text/event-stream")).toEqual([1, 2]);
  });

  it("reads a JSON reply however it is laid out", async () => {
    expect(await listed(JSON.stringify(reply, null, 2), "application/json")).toEqual([1, 2]);
  });
});

describe("mcpRequest", () => {
  it("answers as the endpoint sent it, whatever its status", async () => {
    const Listed = Schema.Struct({
      result: Schema.Struct({ tools: Schema.Array(Schema.Struct({ name: Schema.String })) }),
    });

    const Failed = Schema.Struct({ error: Schema.Struct({ message: Schema.String }) });

    const [listed, refused, unknown] = await againstHost(
      Effect.all([
        Effect.flatMap(
          Testing.mcpRequest("tools/list", {}, headersAs()),
          HttpClientResponse.schemaBodyJson(Listed),
        ),
        Testing.mcpRequest(
          "tools/call",
          { name: "renameUser", arguments: { id: "1", name: "Grace" } },
          headersAs("reader"),
        ),
        Effect.flatMap(
          Testing.mcpRequest("tools/call", { name: "missing", arguments: {} }, headersAs()),
          HttpClientResponse.schemaBodyJson(Failed),
        ),
      ]),
    );

    expect(listed.result.tools.map(({ name }) => name)).toContain("getUser");

    // A refusal's status and challenge, which `mcpClient` decodes away.
    expect(refused.status).toBe(403);
    expect(refused.headers["www-authenticate"]).toContain('error="insufficient_scope"');

    expect(unknown.error.message).toContain("missing");
  });
});

describe("mcpRequest metadata", () => {
  it("merges the given _meta under the protocol version the request speaks", async () => {
    const echo = HttpRouter.add(
      "POST",
      "/echo",
      Effect.flatMap(HttpServerRequest.HttpServerRequest, (request) => request.text).pipe(
        Effect.map((body) => HttpServerResponse.text(body)),
        Effect.orDie,
      ),
    );

    const sent = await Testing.mcpRequest(
      "tools/call",
      {
        name: "slow",
        arguments: {},
        _meta: {
          progressToken: "p",
          "io.modelcontextprotocol/protocolVersion": "1999-01-01",
        },
      },
      { url: "/echo" },
    ).pipe(
      Effect.flatMap((response) => response.text),
      Effect.provide(Testing.layer(echo)),
      Effect.runPromise,
    );

    expect(Schema.decodeUnknownSync(Schema.fromJsonString(Sent))(sent).params._meta).toEqual({
      progressToken: "p",
      "io.modelcontextprotocol/protocolVersion": "2026-07-28",
      "io.modelcontextprotocol/clientCapabilities": {},
      "io.modelcontextprotocol/clientInfo": { name: "effect-actions", version: "0" },
    });
  });
});

const Sent = Schema.Struct({
  params: Schema.Struct({ _meta: Schema.Record(Schema.String, Schema.Json) }),
});

describe("layer", () => {
  it("runs requests in the program's context, middleware and handlers alike", async () => {
    const Stage = Context.Reference<string>("testing-test/Stage", { defaultValue: () => "real" });

    const stamped = HttpRouter.middleware((route) =>
      Effect.flatMap(Effect.service(Stage), (stage) =>
        Effect.map(route, (response) => HttpServerResponse.setHeader(response, "x-stage", stage)),
      ),
    ).layer;

    const routes = HttpRouter.add(
      "GET",
      "/stage",
      Effect.map(Effect.service(Stage), HttpServerResponse.text),
    ).pipe(Layer.provide(stamped));

    const [header, body] = await Effect.runPromise(
      Effect.gen(function* () {
        const response = yield* HttpClient.get("/stage");

        return [response.headers["x-stage"], yield* response.text] as const;
      }).pipe(Effect.provide(Testing.layer(routes)), Effect.provideService(Stage, "test")),
    );

    expect([header, body]).toEqual(["test", "test"]);
  });

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
          doubled: yield* (yield* mcpAs()).double({ value: 2 }),
        };
      }),
    );

    expect(result.user).toEqual({ id: "1", name: "Ada" });
    expect(result.missing).toEqual(new UserNotFound({ id: "404" }));
    expect(result.status).toEqual({ service: "effect-actions", users: 2 });
    expect(result.doubled).toBe(4);
  });

  it("answers a remote ActionCli command in memory", async () => {
    const command = ActionCli.command(Http, Status);

    const [, output] = await logged(Command.runWith(command, { version: "0" })([])).pipe(
      Effect.provide(cliServices),
      againstHost,
    );

    expect(JSON.parse(output.join("\n"))).toEqual({ service: "effect-actions", users: 2 });
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
      ...[
        "/where",
        "where",
        "./where?x=1",
        "http://localhost/where",
        "https://api.example/where",
      ].map(get),
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
      "http://localhost/where?x=1",
      "http://localhost/where",
      "https://api.example/where",
      "https://api.example/where",
    ]);

    // A URL that resolves to nothing fails as the native client's typed error, not a defect.
    const invalid = await Effect.all(
      ["http://", "http://[invalid"].map((url) => Effect.flip(get(url))),
    ).pipe(Effect.provide(Testing.layer(routes)), Effect.runPromise);

    expect(
      invalid.map((error) => HttpClientError.isHttpClientError(error) && error.reason._tag),
    ).toEqual(["InvalidUrlError", "InvalidUrlError"]);
  });

  it("sends the Host header of the request's URL, as the network does", async () => {
    const routes = HttpRouter.add(
      "GET",
      "/host",
      Effect.map(HttpServerRequest.HttpServerRequest, ({ headers }) =>
        HttpServerResponse.text(headers.host ?? "none"),
      ),
    );

    const text = (request: HttpClientRequest.HttpClientRequest) =>
      Effect.flatMap(HttpClient.execute(request), (response) => response.text);

    const hosts = await Effect.all([
      text(HttpClientRequest.get("/host")),
      text(HttpClientRequest.get("https://api.example.com:8443/host")),
      text(HttpClientRequest.get("/host").pipe(HttpClientRequest.setHeader("host", "given"))),
    ]).pipe(Effect.provide(Testing.layer(routes)), Effect.runPromise);

    expect(hosts).toEqual(["localhost", "api.example.com:8443", "given"]);
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
