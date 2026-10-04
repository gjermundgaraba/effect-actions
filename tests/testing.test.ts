import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "@effect/vitest";
import { NodeFileSystem, NodePath } from "@effect/platform-node";
import { Context, Effect, FileSystem, Layer, Path, Schema, SchemaGetter, Stream } from "effect";
import {
  Etag,
  FetchHttpClient,
  HttpClient,
  HttpClientError,
  HttpClientRequest,
  HttpClientResponse,
  HttpRouter,
  HttpServer,
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
import * as ActionMcp from "../src/ActionMcp.js";
import * as Testing from "../src/Testing.js";
import { as } from "./requests.js";

/** `program` against the example host, answered in memory with fresh example state. */
const againstHost = <A, E>(program: Effect.Effect<A, E, HttpClient.HttpClient>) =>
  program.pipe(Effect.provide(Testing.layer(host)));

/** Headers carrying `token` as its bearer token, for a raw request. */
const headersAs = (token = "alice") => ({ headers: { authorization: `Bearer ${token}` } });

/** The example host's MCP client, as `token`'s actor. */
const mcpAs = (token = "alice") =>
  Testing.mcpClient([GetUser, RenameUser, Double, WhoAmI], as(token));

describe("mcpClient", () => {
  it.effect("encodes the input and decodes the success from the structured content", () =>
    Effect.gen(function* () {
      const results = yield* againstHost(
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
    }),
  );

  it.effect("fails with a declared error or a refusal as its decoded value", () =>
    Effect.gen(function* () {
      const results = yield* againstHost(
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
    }),
  );

  it.effect("decodes a built-in error a tool returns as its class", () =>
    Effect.gen(function* () {
      const Refuse = Action.make("refuse", { description: "Refuses", access: "write" });
      const Reject = Action.make("reject", { description: "Rejects its input", access: "write" });

      const app = Action.implement(
        [Refuse, Reject],
        {
          refuse: () => Effect.fail(new Action.Forbidden({ message: "Never." })),
          reject: () => Effect.fail(new Action.InvalidInput({ message: "Out of range." })),
        },
        Action.allowAll,
      );

      const results = yield* Effect.gen(function* () {
        const mcp = yield* Testing.mcpClient([Refuse, Reject]);

        return yield* Effect.all([Effect.flip(mcp.refuse()), Effect.flip(mcp.reject())]);
      }).pipe(
        Effect.provide(Testing.layer(ActionMcp.layerHttp(app, { name: "test", version: "0" }))),
      );

      expect(results).toEqual([
        new Action.Forbidden({ message: "Never." }),
        new Action.InvalidInput({ message: "Out of range." }),
      ]);
    }),
  );

  it.effect("decodes a declared error of any shape, a string included", () =>
    Effect.gen(function* () {
      const Fail = Action.make("fail", {
        description: "Fails with a string",
        access: "write",
        success: Schema.String,
        errors: [Schema.String],
      });

      const routes = ActionMcp.layerHttp(
        Action.implement(Fail, () => Effect.fail("failure"), Action.allowAll),
        { name: "test", version: "0" },
      );

      const result = yield* Testing.mcpClient([Fail]).pipe(
        Effect.flatMap((mcp) => Effect.flip(mcp.fail())),
        Effect.provide(Testing.layer(routes)),
      );

      expect(result).toBe("failure");

      // A tool's error is a tool result: in any other answer's body, it is that answer.
      const other = yield* Testing.mcpClient([Fail], { url: "/broken" }).pipe(
        Effect.flatMap((mcp) => Effect.flip(mcp.fail())),
        Effect.provide(
          Testing.layer(
            HttpRouter.add(
              "POST",
              "/broken",
              HttpServerResponse.text('"failure"', { status: 500 }),
            ),
          ),
        ),
      );

      expect(String(other)).toContain('answered 500: "failure"');
    }),
  );

  it.effect("decodes a declared error whose schema decodes asynchronously", () =>
    Effect.gen(function* () {
      const Later = Schema.String.pipe(
        Schema.decodeTo(Schema.String, {
          decode: SchemaGetter.transformEffect((reason: string) =>
            Effect.as(
              Effect.promise(() => Promise.resolve()),
              reason,
            ),
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
        Action.implement(Slow, () => Effect.fail(new Late({ reason: "busy" })), Action.allowAll),
        { name: "test", version: "0" },
      );

      const failure = yield* Testing.mcpClient([Slow]).pipe(
        Effect.flatMap((mcp) => Effect.flip(mcp.slow())),
        Effect.provide(Testing.layer(routes)),
      );

      expect(failure).toEqual(new Late({ reason: "busy" }));
    }),
  );

  it.effect("returns nothing for an action that returns nothing, over HTTP and MCP alike", () =>
    Effect.gen(function* () {
      const Reset = Action.make("reset", { description: "Reset", access: "write" });
      const Http = ActionHttp.make([Reset]);
      const reset = Action.implement(Reset, () => Effect.void, Action.allowAll);

      const routes = Layer.mergeAll(
        ActionHttp.layer(Http, reset),
        ActionMcp.layerHttp(reset, { name: "test", version: "0" }),
      );

      const results = yield* Effect.gen(function* () {
        const client = yield* ActionHttp.client(Http);

        const mcp = yield* Testing.mcpClient([Reset]);

        return [yield* client.reset(), yield* mcp.reset()];
      }).pipe(Effect.provide(Testing.layer(routes)));

      expect(results).toEqual([undefined, undefined]);
    }),
  );

  it.effect("takes a left-out argument as the input {} decodes to, an input class's instance", () =>
    Effect.gen(function* () {
      class Filters extends Schema.Class<Filters>("Filters")({
        tag: Schema.optionalKey(Schema.String),
      }) {}

      const List = Action.make("list", {
        description: "List notes, all of them without a tag",
        access: "read",
        input: Filters,
        success: Schema.String,
      });

      const list = Action.implement(
        List,
        (filters) => Effect.succeed(`${filters instanceof Filters}: ${filters.tag ?? "all"}`),
        Action.allowAll,
      );

      const results = yield* Effect.flatMap(Testing.mcpClient([List]), (mcp) =>
        Effect.all([mcp.list(), mcp.list(new Filters({ tag: "x" }))]),
      ).pipe(
        Effect.provide(Testing.layer(ActionMcp.layerHttp(list, { name: "test", version: "0" }))),
      );

      expect(results).toEqual(["true: all", "true: x"]);
    }),
  );

  it.effect("fails with an McpCallError holding any other answer", () =>
    Effect.gen(function* () {
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
          Testing.mcpClient([Missing], { ...as("alice"), ...(url === undefined ? {} : { url }) }),
          (mcp) => Effect.flip(mcp.missing_tool()),
        );

      const failures = yield* againstHost(
        Effect.all([
          Effect.flatMap(Testing.mcpClient([Loose], as("alice")), (mcp) =>
            Effect.flip(mcp.getUser({ id: 1 })),
          ),
          missing(),
          missing("/nowhere"),
        ]),
      );

      // Answers no MCP server gives: no JSON-RPC reply, and a result without its structure.
      const odd = yield* Effect.all([missing("/garbled"), missing("/bare")]).pipe(
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
    }),
  );

  it.effect("resolves a relative url only under layer", () =>
    Effect.gen(function* () {
      const failure = yield* Testing.mcpClient([Status]).pipe(
        Effect.flatMap((mcp) => Effect.flip(mcp.status())),
        Effect.provide(FetchHttpClient.layer),
      );

      expect(HttpClientError.isHttpClientError(failure) && failure.reason._tag).toBe(
        "InvalidUrlError",
      );
    }),
  );

  const Listed = Action.make("listed", {
    description: "Lists numbers",
    access: "read",
    success: Schema.Array(Schema.Finite),
  });

  const reply = {
    jsonrpc: "2.0",
    id: 1,
    result: { content: [{ type: "text", text: "[1,2]" }], structuredContent: [1, 2] },
  };

  /** `Listed` against a route answering `body` with `contentType`. */
  const listed = (body: string, contentType: string) =>
    Effect.flatMap(Testing.mcpClient([Listed], { url: "/events" }), (mcp) => mcp.listed()).pipe(
      Effect.provide(
        Testing.layer(
          HttpRouter.add("POST", "/events", HttpServerResponse.text(body, { contentType })),
        ),
      ),
    );

  it.effect("reads the reply from an event stream that carries notifications first", () =>
    Effect.gen(function* () {
      const stream = [
        { jsonrpc: "2.0", method: "notifications/message", params: { level: "info", data: "x" } },
        reply,
      ]
        .map((message) => `data: ${JSON.stringify(message)}\n\n`)
        .join("");

      expect(yield* listed(stream, "text/event-stream")).toEqual([1, 2]);
    }),
  );

  it.effect("reads an event whose data spans several lines", () =>
    Effect.gen(function* () {
      const event = JSON.stringify(reply, null, 2)
        .split("\n")
        .map((line) => `data: ${line}\n`)
        .join("");

      expect(yield* listed(`${event}\n`, "text/event-stream")).toEqual([1, 2]);
    }),
  );
});

describe("mcpRequest", () => {
  it.effect("answers as the endpoint sent it, whatever its status", () =>
    Effect.gen(function* () {
      const Listed = Schema.Struct({
        result: Schema.Struct({ tools: Schema.Array(Schema.Struct({ name: Schema.String })) }),
      });

      const Failed = Schema.Struct({ error: Schema.Struct({ message: Schema.String }) });

      const [listed, refused, unknown] = yield* againstHost(
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
    }),
  );

  it.effect("answers a JSON body its parsed message reproduces, less the final newline", () =>
    Effect.gen(function* () {
      const text = yield* againstHost(
        Effect.flatMap(
          Testing.mcpRequest(
            "tools/call",
            { name: "double", arguments: { value: "21" } },
            headersAs(),
          ),
          (response) => response.text,
        ),
      );

      expect(`${JSON.stringify(JSON.parse(text))}\n`).toBe(text);
    }),
  );
});

describe("mcpRequest metadata", () => {
  it.effect("merges the given _meta under the protocol version the request speaks", () =>
    Effect.gen(function* () {
      const echo = HttpRouter.add(
        "POST",
        "/echo",
        Effect.flatMap(HttpServerRequest.HttpServerRequest, (request) => request.text).pipe(
          Effect.map((body) => HttpServerResponse.text(body)),
          Effect.orDie,
        ),
      );

      const sent = yield* Testing.mcpRequest(
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
      );

      expect(Schema.decodeUnknownSync(Schema.fromJsonString(Sent))(sent).params._meta).toEqual({
        progressToken: "p",
        "io.modelcontextprotocol/protocolVersion": "2026-07-28",
        "io.modelcontextprotocol/clientCapabilities": {},
        "io.modelcontextprotocol/clientInfo": { name: "effect-actions", version: "0" },
      });
    }),
  );
});

const Sent = Schema.Struct({
  params: Schema.Struct({ _meta: Schema.Record(Schema.String, Schema.Json) }),
});

describe("layer", () => {
  it.effect("runs requests in the program's context, middleware and handlers alike", () =>
    Effect.gen(function* () {
      const Stage = Context.Reference<string>("testing-test/Stage", {
        defaultValue: () => "real",
      });

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

      const [header, body] = yield* Effect.gen(function* () {
        const response = yield* HttpClient.get("/stage");

        return [response.headers["x-stage"], yield* response.text] as const;
      }).pipe(Effect.provide(Testing.layer(routes)), Effect.provideService(Stage, "test"));

      expect([header, body]).toEqual(["test", "test"]);
    }),
  );

  class Visits extends Context.Service<Visits, { count: number }>()("testing/Visits") {}

  it("answers through a web handler the test serves, which it neither builds nor disposes", async () => {
    // As a harness serves the host for its Promise tests too: built once, by the handler.
    const web = HttpRouter.toWebHandler(host.pipe(Layer.provide(HttpServer.layerServices)), {
      disableLogger: true,
    });

    /** `program` on a client answered by the handler. */
    const run = <A, E>(program: Effect.Effect<A, E, HttpClient.HttpClient>) =>
      program.pipe(Effect.provide(Testing.layer(web.handler)), Effect.runPromise);

    try {
      const renamed = await run(
        Effect.flatMap(ActionHttp.client(Http, as("alice")), (client) =>
          client.renameUser({ id: "1", name: "Grace" }),
        ),
      );

      // A second layer on the same handler: the rename stands, and every client answers.
      const answered = await run(
        Effect.gen(function* () {
          const client = yield* ActionHttp.client(Http, as("alice"));
          const listed = yield* Testing.mcpRequest("tools/list", {}, headersAs());

          return [
            yield* client.getUser({ id: "1" }),
            yield* (yield* mcpAs()).getUser({ id: "1" }),
            listed.status,
          ];
        }),
      );

      expect(renamed).toEqual({ id: "1", name: "Grace" });
      expect(answered).toEqual([{ id: "1", name: "Grace" }, { id: "1", name: "Grace" }, 200]);
    } finally {
      await web.dispose();
    }
  });

  it.effect(
    "resolves a relative URL against http://localhost, and answers any origin in memory",
    () =>
      Effect.gen(function* () {
        const routes = HttpRouter.add(
          "GET",
          "/where",
          Effect.map(HttpServerRequest.HttpServerRequest, (request) =>
            HttpServerResponse.text(request.originalUrl),
          ),
        );

        const get = (url: string) =>
          Effect.flatMap(HttpClient.get(url), (response) => response.text);

        const urls = yield* Effect.all([
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
        ]).pipe(Effect.provide(Testing.layer(routes)));

        expect(urls).toEqual([
          "http://localhost/where",
          "http://localhost/where",
          "http://localhost/where?x=1",
          "http://localhost/where",
          "https://api.example/where",
          "https://api.example/where",
        ]);

        // A URL that resolves to nothing fails as the native client's typed error, not a defect.
        const invalid = yield* Effect.all(
          ["http://", "http://[invalid"].map((url) => Effect.flip(get(url))),
        ).pipe(Effect.provide(Testing.layer(routes)));

        expect(
          invalid.map((error) => HttpClientError.isHttpClientError(error) && error.reason._tag),
        ).toEqual(["InvalidUrlError", "InvalidUrlError"]);
      }),
  );

  it.effect("sends the Host header of the request's URL, as the network does", () =>
    Effect.gen(function* () {
      const routes = HttpRouter.add(
        "GET",
        "/host",
        Effect.map(HttpServerRequest.HttpServerRequest, ({ headers }) =>
          HttpServerResponse.text(headers.host ?? "none"),
        ),
      );

      const text = (request: HttpClientRequest.HttpClientRequest) =>
        Effect.flatMap(HttpClient.execute(request), (response) => response.text);

      const hosts = yield* Effect.all([
        text(HttpClientRequest.get("/host")),
        text(HttpClientRequest.get("https://api.example.com:8443/host")),
        text(HttpClientRequest.get("/host").pipe(HttpClientRequest.setHeader("host", "given"))),
      ]).pipe(Effect.provide(Testing.layer(routes)));

      expect(hosts).toEqual(["localhost", "api.example.com:8443", "given"]);
    }),
  );

  /** A `fetch` standing in for the network, answering every request with `network`. */
  const network: typeof globalThis.fetch = () => Promise.resolve(new Response("network"));

  /** The text of a GET of `url`. */
  const textOf = (url: string) => Effect.flatMap(HttpClient.get(url), (response) => response.text);

  /** Another client of the program, such as an exporter's, on `FetchHttpClient.layer`. */
  class Probe extends Context.Service<
    Probe,
    Effect.Effect<string, HttpClientError.HttpClientError>
  >()("testing/Probe") {}

  /** `Probe`, sending through its own `fetch`, given when it is built. */
  const probe = Layer.effect(
    Probe,
    Effect.map(HttpClient.HttpClient, (client) =>
      textOf("https://elsewhere.example/").pipe(
        Effect.provideService(HttpClient.HttpClient, client),
      ),
    ),
  ).pipe(
    Layer.provide(FetchHttpClient.layer),
    Layer.provide(Layer.succeed(FetchHttpClient.Fetch, network)),
  );

  const where = Layer.merge(
    HttpRouter.add("GET", "/where", HttpServerResponse.text("routes")),
    // Reads the body before answering, so a streamed one has run.
    HttpRouter.add(
      "POST",
      "/where",
      Effect.flatMap(HttpServerRequest.HttpServerRequest, (request) =>
        Effect.as(request.text, HttpServerResponse.text("routes")),
      ),
    ),
  );

  /** The routes' answer under `layer`, and `Probe`'s. */
  const probed = Effect.all([textOf("/where"), Effect.flatten(Probe)]);

  /** The routes' answer under `layer`, and another request of the program's, outside it. */
  const around = Effect.all([
    textOf("/where").pipe(Effect.provide(Testing.layer(where))),
    textOf("https://elsewhere.example/"),
  ]);

  /**
   * The routes' answer to a request whose mapping calls `Probe`, as fetching a token might,
   * and `Probe`'s answer there.
   */
  const mapped = Effect.gen(function* () {
    const answers: Array<string> = [];
    const call = yield* Probe;

    const client = HttpClient.mapRequestEffect(yield* HttpClient.HttpClient, (request) =>
      call.pipe(
        Effect.tap((answer) => Effect.sync(() => answers.push(answer))),
        Effect.as(request),
      ),
    );

    const answer = yield* textOf("/where").pipe(
      Effect.provideService(HttpClient.HttpClient, client),
    );

    return [answer, ...answers];
  });

  /**
   * The routes' answer to a request whose streamed body calls `Probe`, as a proxied upload
   * might, and `Probe`'s answer there.
   */
  const streamed = Effect.gen(function* () {
    const answers: Array<string> = [];
    const call = yield* Probe;

    const body = Stream.fromEffect(
      call.pipe(Effect.tap((answer) => Effect.sync(() => answers.push(answer)))),
    ).pipe(Stream.encodeText);

    const answer = yield* HttpClient.execute(
      HttpClientRequest.post("/where").pipe(HttpClientRequest.bodyStream(body)),
    ).pipe(Effect.flatMap((response) => response.text));

    return [answer, ...answers];
  });

  it.effect.each([
    [
      "a FetchHttpClient merged after it",
      probed.pipe(Effect.provide(Layer.mergeAll(Testing.layer(where), probe))),
    ],
    [
      "a FetchHttpClient merged before it",
      probed.pipe(Effect.provide(Layer.mergeAll(probe, Testing.layer(where)))),
    ],
    [
      "FetchHttpClient.layer provided around the program",
      around.pipe(
        Effect.provide(
          FetchHttpClient.layer.pipe(Layer.provide(Layer.succeed(FetchHttpClient.Fetch, network))),
        ),
      ),
    ],
    [
      "FetchHttpClient.Fetch provided around the program",
      around.pipe(
        Effect.provide(FetchHttpClient.layer),
        Effect.provideService(FetchHttpClient.Fetch, network),
      ),
    ],
    [
      "a FetchHttpClient called while mapping its request",
      mapped.pipe(Effect.provide(Layer.mergeAll(probe, Testing.layer(where)))),
    ],
    [
      "a FetchHttpClient called while its streamed body is read",
      streamed.pipe(Effect.provide(Layer.mergeAll(probe, Testing.layer(where)))),
    ],
  ] as const)("keeps its client apart from %s", ([, program]) =>
    Effect.gen(function* () {
      // The routes answer the layer's requests, and the network every other.
      expect(yield* program).toEqual(["routes", "network"]);
    }),
  );

  it.effect(
    "serves routes with the services their middleware provides, until its scope closes",
    () =>
      Effect.gen(function* () {
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

        const [visited, missing] = yield* Effect.gen(function* () {
          const response = yield* HttpClient.get("/visits");
          const visited = [response.status, yield* response.text, released] as const;

          return [visited, (yield* HttpClient.get("/missing")).status] as const;
        }).pipe(Effect.provide(Testing.layer(routes)));

        expect(visited).toEqual([200, "1", false]);
        expect(missing).toBe(404);
        expect(visits.count).toBe(1);
        expect(released).toBe(true);
      }),
  );

  it.effect("fails with the routes' build failure", () =>
    Effect.gen(function* () {
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
          Action.allowAll,
        ),
      );

      const failure = yield* HttpClient.get("/api/ping").pipe(
        Effect.provide(Testing.layer(routes)),
        Effect.flip,
      );

      expect(failure).toEqual(new Unavailable());

      // A hook's builder fails the routes the same way, with its typed failure.
      const hooked = ActionHttp.layer(
        ActionHttp.make([Ping]),
        Action.implement(Ping, () => Effect.succeed(true), Effect.fail(new Unavailable())),
      );

      const hookFailure = yield* HttpClient.get("/api/ping").pipe(
        Effect.provide(Testing.layer(hooked)),
        Effect.flip,
      );

      expect(hookFailure).toEqual(new Unavailable());
    }),
  );

  it.effect("leaves the routes' startup services to the program, which shares them", () =>
    Effect.gen(function* () {
      let built = 0;

      const Visit = Action.make("visit", {
        description: "Count a visit.",
        access: "write",
        success: Schema.Finite,
      });

      const visit = Action.implement(
        Visit,
        Effect.map(Visits, (seen) => () => Effect.sync(() => ++seen.count)),
        Action.allowAll,
      );

      const Http = ActionHttp.make([Visit]);

      const answered = yield* Effect.gen(function* () {
        const client = yield* ActionHttp.client(Http);

        return [yield* client.visit(), (yield* Visits).count];
      }).pipe(
        Effect.provide(
          Testing.layer(ActionHttp.layer(Http, visit)).pipe(
            Layer.provideMerge(Layer.sync(Visits, () => (built++, { count: 0 }))),
          ),
        ),
      );

      expect(answered).toEqual([1, 1]);
      expect(built).toBe(1);
    }),
  );

  it.effect("serves a per-request service provided around it, such as the caller", () =>
    Effect.gen(function* () {
      const routes = HttpRouter.add(
        "GET",
        "/visits",
        Effect.map(Visits, (seen) => HttpServerResponse.text(String(++seen.count))),
      );

      const answered = yield* HttpClient.get("/visits").pipe(
        Effect.flatMap((response) => response.text),
        Effect.provide(
          Testing.layer(routes).pipe(Layer.provide(Layer.succeed(Visits, { count: 0 }))),
        ),
      );

      expect(answered).toBe("1");
    }),
  );

  it.effect("serves a global middleware the per-request service provided around it", () =>
    Effect.gen(function* () {
      // Around every route, reading its service per request, as a rate limit does.
      const counted = HttpRouter.middleware(
        (route) =>
          Effect.flatMap(Visits, (seen) =>
            Effect.map(route, (response) =>
              HttpServerResponse.setHeader(response, "x-visits", String(++seen.count)),
            ),
          ),
        { global: true },
      );

      const routes = Layer.mergeAll(
        HttpRouter.add("GET", "/", HttpServerResponse.empty()),
        counted,
      );

      const visits = yield* HttpClient.get("/").pipe(
        Effect.map((response) => [response.status, response.headers["x-visits"]]),
        Effect.provide(
          Testing.layer(routes).pipe(Layer.provide(Layer.succeed(Visits, { count: 0 }))),
        ),
      );

      expect(visits).toEqual([204, "1"]);
    }),
  );

  it.effect(
    "gives builders and handlers the platform services provided around it, the program's own",
    () =>
      Effect.gen(function* () {
        let built = 0;

        // A fake file system, naming the instance that read.
        const files = Layer.sync(FileSystem.FileSystem, () => {
          const instance = ++built;

          return FileSystem.makeNoop({
            readFileString: (file) => Effect.succeed(`${instance}:${file}`),
          });
        });

        const Read = Action.make("read", {
          description: "Reads a file with its builder's services and with its request's.",
          access: "read",
          input: { name: Schema.String },
          success: Schema.Array(Schema.String),
        });

        /** `name` in the `data` directory, read with `fs`, joined with `path`'s separator. */
        const readData = (fs: FileSystem.FileSystem, path: Path.Path, name: string) =>
          fs.readFileString(path.join("data", name));

        const read = Action.implement(
          Read,
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const path = yield* Path.Path;

            return ({ name }) =>
              Effect.gen(function* () {
                const atStartup = yield* readData(fs, path, name);

                const perRequest = yield* readData(
                  yield* FileSystem.FileSystem,
                  yield* Path.Path,
                  name,
                );

                return [atStartup, perRequest];
              }).pipe(Effect.orDie);
          }),
          Action.allowAll,
        );

        const Http = ActionHttp.make([Read]);

        const answered = yield* Effect.gen(function* () {
          const client = yield* ActionHttp.client(Http);
          const fs = yield* FileSystem.FileSystem;

          return [...(yield* client.read({ name: "a.txt" })), yield* fs.readFileString("a.txt")];
        }).pipe(
          Effect.provide(
            Testing.layer(ActionHttp.layer(Http, read)).pipe(
              Layer.provide(NodePath.layerWin32),
              Layer.provideMerge(files),
            ),
          ),
        );

        expect(answered).toEqual(["1:data\\a.txt", "1:data\\a.txt", "1:a.txt"]);
        expect(built).toBe(1);
      }),
  );

  const packageJson = fileURLToPath(new URL("../package.json", import.meta.url));

  /** A route answering with the package's `package.json`, as a server's platform reads it. */
  const fileRoute = HttpRouter.add("GET", "/package.json", HttpServerResponse.file(packageJson));

  /** The file route's status and body. */
  const getFile = Effect.flatMap(HttpClient.get("/package.json"), (response) =>
    Effect.map(response.text, (body) => [response.status, body]),
  );

  it.effect("reads files through the FileSystem provided around it, or else a no-op one", () =>
    Effect.gen(function* () {
      const Exists = Action.make("exists", {
        description: "Whether a file exists, to its builder's file system and to its request's.",
        access: "read",
        input: { path: Schema.String },
        success: Schema.Array(Schema.Boolean),
      });

      const exists = Action.implement(
        Exists,
        Effect.map(
          FileSystem.FileSystem,
          (fs) =>
            ({ path }) =>
              Effect.flatMap(FileSystem.FileSystem, (perRequest) =>
                Effect.all([fs.exists(path), perRequest.exists(path)]),
              ).pipe(Effect.orDie),
        ),
        Action.allowAll,
      );

      const Http = ActionHttp.make([Exists]);
      const routes = Layer.mergeAll(ActionHttp.layer(Http, exists), fileRoute);

      const program = Effect.gen(function* () {
        const client = yield* ActionHttp.client(Http);

        return [yield* client.exists({ path: packageJson }), yield* getFile];
      });

      const real = yield* program.pipe(
        Effect.provide(Testing.layer(routes).pipe(Layer.provide(NodeFileSystem.layer))),
      );

      expect(real).toEqual([
        [true, true],
        [200, readFileSync(packageJson, "utf8")],
      ]);

      // Nothing provided around it: a no-op file system, which holds no file.
      const none = yield* program.pipe(Effect.provide(Testing.layer(routes)));

      expect(none).toEqual([
        [false, false],
        [500, expect.any(String)],
      ]);
    }),
  );

  it.effect(
    "gives the routes HttpServer.layerServices' defaults, per request too, when nothing provides them",
    () =>
      Effect.gen(function* () {
        // Read per request: the platform serving a web file, the path separator, the ETag kind.
        const routes = HttpRouter.add(
          "GET",
          "/defaults",
          Effect.gen(function* () {
            const file = new File(["hello"], "hello.txt");
            const path = yield* Path.Path;
            const etag = yield* Effect.flatMap(Etag.Generator, (etags) => etags.fromFileWeb(file));
            const response = yield* HttpServerResponse.fileWeb(file);

            return HttpServerResponse.setHeaders(response, {
              "x-separator": path.sep,
              "x-etag": Etag.toString(etag),
            });
          }),
        );

        const answered = yield* HttpClient.get("/defaults").pipe(
          Effect.flatMap((response) =>
            Effect.map(response.text, (body) => [
              response.status,
              body,
              response.headers["x-separator"],
              response.headers["x-etag"],
            ]),
          ),
          Effect.provide(Testing.layer(routes)),
        );

        expect(answered).toEqual([200, "hello", "/", expect.stringMatching(/^W\//)]);
      }),
  );

  it.effect(
    "serves files from the FileSystem provided around it, whatever platform the program built elsewhere",
    () =>
      Effect.gen(function* () {
        // Built before the layer, on its own no-op file system, and provided to nothing.
        const elsewhere = Layer.effectDiscard(Effect.void).pipe(
          Layer.provide(HttpServer.layerServices),
        );

        const answered = yield* getFile.pipe(
          Effect.provide(
            Testing.layer(fileRoute).pipe(
              Layer.provide(Layer.merge(NodeFileSystem.layer, elsewhere)),
            ),
          ),
        );

        expect(answered).toEqual([200, readFileSync(packageJson, "utf8")]);
      }),
  );
});
