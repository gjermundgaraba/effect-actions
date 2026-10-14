import { describe, expect, it } from "@effect/vitest";
import { NodeHttpServer } from "@effect/platform-node";
import { Effect, Layer, Result, Schema, SchemaGetter } from "effect";
import {
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
import { layer as host } from "../support/app/app.js";
import {
  Double,
  GetUser,
  RenameUser,
  Status,
  UserNotFound,
  WhoAmI,
} from "../support/app/contracts.js";
import { CurrentActor } from "../support/app/authorization.js";
import * as Action from "../../src/contract/Action.js";
import * as Authentication from "../../src/authentication/Authentication.js";
import * as ActionHttp from "../../src/http/ActionHttp.js";
import * as ActionMcp from "../../src/mcp/ActionMcp.js";
import * as Testing from "../../src/testing/Testing.js";
import { as } from "../support/requests.js";

const againstHost = <A, E>(program: Effect.Effect<A, E, HttpClient.HttpClient>) =>
  program.pipe(Effect.provide(Testing.layer(host)));

const Sent = Schema.Struct({
  params: Schema.Struct({ _meta: Schema.Record(Schema.String, Schema.Json) }),
});

const headersAs = (token = "alice") => ({ headers: { authorization: `Bearer ${token}` } });

const mcpAs = (token = "alice") =>
  ActionMcp.client([GetUser, RenameUser, Double, WhoAmI], as(token));

describe("client", () => {
  it.effect("encodes the input and decodes the success from the structured content", () =>
    Effect.gen(function* () {
      const results = yield* againstHost(
        Effect.gen(function* () {
          const mcp = yield* mcpAs();

          return [
            yield* mcp.getUser({ id: "1" }),
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

  it.effect("fails with InvalidInput for input that does not encode, sending nothing", () =>
    Effect.gen(function* () {
      const mcp = yield* ActionMcp.client([RenameUser]);

      const error = yield* Effect.flip(mcp.renameUser({ id: "1", name: "" }));

      expect(error).toBeInstanceOf(Action.InvalidInput);
      expect(error).toMatchObject({ issues: [{ path: ["name"] }] });
    }).pipe(
      Effect.provideService(
        HttpClient.HttpClient,
        HttpClient.make(() => Effect.die("sent")),
      ),
    ),
  );

  it.effect("decodes a built-in error a tool returns as its class", () =>
    Effect.gen(function* () {
      const Refuse = Action.make("refuse", {
        description: "Refuses",
        readOnly: false,
        caller: Action.Anyone,
      });

      const Reject = Action.make("reject", {
        description: "Rejects its input",
        readOnly: false,
        caller: Action.Anyone,
      });

      const app = Action.implement([Refuse, Reject], {
        refuse: () => Effect.fail(new Action.Forbidden({ message: "Never." })),
        reject: () => Effect.fail(new Action.InvalidInput({ message: "Out of range." })),
      });

      const results = yield* Effect.gen(function* () {
        const mcp = yield* ActionMcp.client([Refuse, Reject]);

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
        readOnly: false,
        caller: Action.Anyone,
        success: Schema.String,
        error: [Schema.String],
      });

      const routes = ActionMcp.layerHttp(
        Action.implement(Fail, () => Effect.fail("failure")),
        { name: "test", version: "0" },
      );

      const result = yield* ActionMcp.client([Fail]).pipe(
        Effect.flatMap((mcp) => Effect.flip(mcp.fail())),
        Effect.provide(Testing.layer(routes)),
      );

      expect(result).toBe("failure");

      const failureIn500Body = yield* ActionMcp.client([Fail], { url: "/broken" }).pipe(
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

      expect(String(failureIn500Body)).toContain('answered 500: "failure"');
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
        readOnly: true,
        caller: Action.Anyone,
        success: Schema.String,
        error: [Late],
      });

      const routes = ActionMcp.layerHttp(
        Action.implement(Slow, () => Effect.fail(new Late({ reason: "busy" }))),
        { name: "test", version: "0" },
      );

      const failure = yield* ActionMcp.client([Slow]).pipe(
        Effect.flatMap((mcp) => Effect.flip(mcp.slow())),
        Effect.provide(Testing.layer(routes)),
      );

      expect(failure).toEqual(new Late({ reason: "busy" }));
    }),
  );

  it.effect("returns nothing for an action that returns nothing, over HTTP and MCP alike", () =>
    Effect.gen(function* () {
      const Reset = Action.make("reset", {
        description: "Reset",
        readOnly: false,
        caller: Action.Anyone,
      });

      const Http = ActionHttp.make([Reset]);
      const reset = Action.implement(Reset, () => Effect.void);

      const routes = Layer.mergeAll(
        ActionHttp.layer(Http, reset),
        ActionMcp.layerHttp(reset, { name: "test", version: "0" }),
      );

      const results = yield* Effect.gen(function* () {
        const client = yield* ActionHttp.client(Http);

        const mcp = yield* ActionMcp.client([Reset]);

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
        readOnly: true,
        caller: Action.Anyone,
        input: Filters,
        success: Schema.String,
      });

      const list = Action.implement(List, (filters) =>
        Effect.succeed(`${filters instanceof Filters}: ${filters.tag ?? "all"}`),
      );

      const results = yield* Effect.flatMap(ActionMcp.client([List]), (mcp) =>
        Effect.all([mcp.list(), mcp.list(new Filters({ tag: "x" }))]),
      ).pipe(
        Effect.provide(Testing.layer(ActionMcp.layerHttp(list, { name: "test", version: "0" }))),
      );

      expect(results).toEqual(["true: all", "true: x"]);
    }),
  );

  it.effect(
    "decodes an error the endpoint's verifier declares, given its authentication, for a protected tool alone",
    () =>
      Effect.gen(function* () {
        class Unavailable extends Schema.TaggedError<Unavailable>()(
          "Unavailable",
          { retryAfter: Schema.Finite },
          { httpApiStatus: 503 },
        ) {}

        const Guarded = Authentication.make("mcp-client.Guarded", CurrentActor, {
          error: Unavailable,
        });

        const unavailable = new Unavailable({ retryAfter: 5 });

        const failures = yield* Effect.all([
          Effect.flatMap(ActionMcp.client([WhoAmI, Status], { authentication: Guarded }), (mcp) =>
            Effect.all([Effect.flip(mcp.whoAmI()), Effect.flip(mcp.status())]),
          ),
          Effect.flatMap(ActionMcp.client([WhoAmI]), (mcp) => Effect.flip(mcp.whoAmI())),
        ]).pipe(
          Effect.provide(
            Testing.layer(async () =>
              Response.json(Schema.encodeSync(Unavailable)(unavailable), { status: 503 }),
            ),
          ),
        );

        const undeclared = {
          _tag: "McpCallError",
          reason: {
            _tag: "StatusError",
            status: 503,
            body: JSON.stringify(Schema.encodeSync(Unavailable)(unavailable)),
          },
        };

        expect(failures).toMatchObject([
          [unavailable, { ...undeclared, tool: "status" }],
          { ...undeclared, tool: "whoAmI" },
        ]);
      }),
  );

  it.effect("fails with an McpCallError holding any other answer", () =>
    Effect.gen(function* () {
      const Loose = Action.make("getUser", {
        description: "The host's getUser, with an input it refuses",
        readOnly: true,
        caller: Action.Anyone,
        input: { id: Schema.Finite },
        success: Schema.String,
      });

      const Missing = Action.make("missing_tool", {
        description: "Not served",
        readOnly: true,
        caller: Action.Anyone,
        success: Schema.String,
      });

      const callMissingAt = (url?: string) =>
        Effect.flatMap(
          ActionMcp.client([Missing], { ...as("alice"), ...(url === undefined ? {} : { url }) }),
          (mcp) => Effect.flip(mcp.missing_tool()),
        );

      const failures = yield* againstHost(
        Effect.all([
          Effect.flatMap(ActionMcp.client([Loose], as("alice")), (mcp) =>
            Effect.flip(mcp.getUser({ id: 1 })),
          ),
          callMissingAt(),
          callMissingAt("/nowhere"),
        ]),
      );

      const nonMcpAnswers = yield* Effect.all([
        callMissingAt("/garbled"),
        callMissingAt("/bare"),
      ]).pipe(
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

      expect([...failures, ...nonMcpAnswers]).toMatchObject([
        {
          _tag: "McpCallError",
          tool: "getUser",
          reason: { _tag: "UndeclaredError" },
        },
        {
          tool: "missing_tool",
          reason: { _tag: "ProtocolError", code: -32602 },
        },
        { tool: "missing_tool", reason: { _tag: "StatusError", status: 404 } },
        { tool: "missing_tool", reason: { _tag: "NoReply", body: "not json" } },
        {
          tool: "missing_tool",
          reason: {
            _tag: "NoStructuredContent",
            body: JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [] } }),
          },
        },
      ]);

      expect(String(failures[0])).toContain("Invalid parameters for tool 'getUser'");

      expect(String(nonMcpAnswers[0])).toContain(
        'MCP tools/call "missing_tool" had no reply: not json',
      );

      const status = yield* callMissingAt("/nowhere").pipe(
        Effect.flip,
        Effect.flatMap(Effect.fail),
        Effect.catchReason("McpCallError", "StatusError", ({ status }) => Effect.succeed(status)),
        againstHost,
      );

      expect(status).toBe(404);
    }),
  );

  it.effect("resolves a relative url only under layer", () =>
    Effect.gen(function* () {
      const failure = yield* ActionMcp.client([Status]).pipe(
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
    readOnly: true,
    caller: Action.Anyone,
    success: Schema.Array(Schema.Finite),
  });

  const reply = {
    jsonrpc: "2.0",
    id: 1,
    result: { content: [{ type: "text", text: "[1,2]" }], structuredContent: [1, 2] },
  };

  const listed = (body: string, contentType: string) =>
    Effect.flatMap(ActionMcp.client([Listed], { url: "/events" }), (mcp) => mcp.listed()).pipe(
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

describe("request", () => {
  it.effect("answers as the endpoint sent it, whatever its status", () =>
    Effect.gen(function* () {
      const Listed = Schema.Struct({
        result: Schema.Struct({ tools: Schema.Array(Schema.Struct({ name: Schema.String })) }),
      });

      const Failed = Schema.Struct({ error: Schema.Struct({ message: Schema.String }) });

      const [listed, refused, unknown] = yield* againstHost(
        Effect.all([
          Effect.flatMap(
            HttpClient.execute(ActionMcp.request("tools/list", {}, headersAs())),
            HttpClientResponse.schemaBodyJson(Listed),
          ),
          HttpClient.execute(
            ActionMcp.request(
              "tools/call",
              { name: "renameUser", arguments: { id: "1", name: "Grace" } },
              headersAs("reader"),
            ),
          ),
          Effect.flatMap(
            HttpClient.execute(
              ActionMcp.request("tools/call", { name: "missing", arguments: {} }, headersAs()),
            ),
            HttpClientResponse.schemaBodyJson(Failed),
          ),
        ]),
      );

      expect(listed.result.tools.map(({ name }) => name)).toContain("getUser");

      expect(refused.status).toBe(403);
      expect(refused.headers["www-authenticate"]).toContain('error="insufficient_scope"');

      expect(unknown.error.message).toContain("missing");
    }),
  );

  it.effect("answers a JSON body its parsed message reproduces, less the final newline", () =>
    Effect.gen(function* () {
      const text = yield* againstHost(
        Effect.flatMap(
          HttpClient.execute(
            ActionMcp.request(
              "tools/call",
              { name: "double", arguments: { value: "21" } },
              headersAs(),
            ),
          ),
          (response) => response.text,
        ),
      );

      expect(`${JSON.stringify(JSON.parse(text))}\n`).toBe(text);
    }),
  );

  it("converts to the web Request a web handler takes", async () => {
    const web = HttpRouter.toWebHandler(host.pipe(Layer.provide(HttpServer.layerServices)), {
      disableLogger: true,
    });

    const RefusedToolResult = Schema.Struct({
      result: Schema.Struct({
        isError: Schema.Boolean,
        content: Schema.Array(Schema.Struct({ text: Schema.String })),
      }),
    });

    const sendToHandler = (method: string, params: Parameters<typeof ActionMcp.request>[1]) =>
      web.handler(
        Result.getOrThrow(
          HttpClientRequest.toWebResult(
            ActionMcp.request(method, params, { url: "http://localhost/mcp", ...headersAs() }),
          ),
        ),
      );

    try {
      const listed = await sendToHandler("tools/list", {});

      expect(listed.status).toBe(200);
      expect(listed.headers.get("content-type")).toContain("application/json");

      const undeclaredArgumentCall = await sendToHandler("tools/call", {
        name: "getUser",
        arguments: { id: "1", extra: true },
      });

      const { result } = Schema.decodeUnknownSync(RefusedToolResult)(
        await undeclaredArgumentCall.json(),
      );

      expect(result.isError).toBe(true);
      expect(result.content.map(({ text }) => text).join()).toContain("getUser");
    } finally {
      await web.dispose();
    }

    const relativeDefaultUrl = HttpClientRequest.toWebResult(ActionMcp.request("tools/list"));

    expect(Result.isFailure(relativeDefaultUrl)).toBe(true);
  });

  it.effect("reaches a listening server through a client that prepends its URL", () =>
    Effect.gen(function* () {
      const response = yield* HttpClient.execute(ActionMcp.request("tools/list"));

      expect(response.status).toBe(200);
    }).pipe(
      Effect.provide(
        HttpRouter.serve(host, { disableLogger: true, disableListenLog: true }).pipe(
          Layer.provideMerge(NodeHttpServer.layerTest),
        ),
      ),
    ),
  );
});

describe("request metadata", () => {
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

      const sent = yield* HttpClient.execute(
        ActionMcp.request(
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
        ),
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
