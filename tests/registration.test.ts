import { HttpRouter, HttpServer } from "effect/unstable/http";
import { withMcpClient } from "../src/TestingClient.js";
import { describe, expect, it, onTestFinished } from "vite-plus/test";
import { Deferred, Effect, JsonPointer, Layer, Predicate, Schema } from "effect";
import { McpProtocol, McpSchema } from "effect/unstable/ai";
import { OpenApi } from "effect/unstable/httpapi";
import * as Action from "../src/Action.js";
import * as ActionGroup from "../src/ActionGroup.js";
import * as ActionHttp from "../src/ActionHttp.js";
import * as ActionMcp from "../src/ActionMcp.js";
import { makeTestHttp, makeTestMcp, testMcpUrl } from "./server.js";
import { mcpRequest } from "../src/Testing.js";
import { post } from "./requests.js";

const mcpCall = (name: string, args: Schema.Json = {}) =>
  mcpRequest({ url: testMcpUrl, method: "tools/call", params: { name, arguments: args } });

it("forwards the configured MCP protocols", async () => {
  const web = HttpRouter.toWebHandler(
    ActionMcp.layer({
      name: "configured",
      version: "0",
      path: "/mcp",
      protocols: [McpProtocol.v2025_11_25],
    }).pipe(Layer.provide(HttpServer.layerServices)),
    { disableLogger: true },
  );

  onTestFinished(() => web.dispose());

  await withMcpClient(
    { fetch: web.handler, path: "/mcp", versionNegotiation: { mode: "legacy" } },
    async (client) => {
      expect((await client.listTools()).tools).toEqual([]);
    },
  );
});

const listTools = async (handler: (request: Request) => Promise<Response>) => {
  const response = await handler(mcpRequest({ url: testMcpUrl, method: "tools/list" }));
  expect(response.status).toBe(200);

  const reply = Schema.decodeUnknownSync(
    Schema.Struct({ result: Schema.Struct({ tools: Schema.Array(McpSchema.Tool) }) }),
  )(await response.json());

  return reply.result.tools;
};

const expectReferencesResolve = (document: Schema.Json, prefix: string) => {
  const refs: string[] = [];

  const visit = (value: Schema.Json | undefined) => {
    if (value === undefined) return;

    if (Array.isArray(value)) return value.forEach(visit);

    if (!Predicate.isObjectKeyword(value)) return;

    for (const [key, item] of Object.entries(value)) {
      if (key === "$ref" && Predicate.isString(item)) refs.push(item);
      else visit(item);
    }
  };

  visit(document);
  expect(refs.length).toBeGreaterThan(0);

  for (const ref of refs) {
    expect(ref.startsWith(prefix)).toBe(true);
    const path = JsonPointer.parseUriFragment(ref);

    if (path === undefined) throw new Error(`Invalid JSON pointer: ${ref}`);
    let target: unknown = document;

    for (const segment of path) {
      const object = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown))(target);
      expect(Object.hasOwn(object, segment)).toBe(true);
      target = object[segment];
    }

    expect(target).toBeDefined();
  }
};

describe("projection boundaries", () => {
  it("registers nothing over HTTP for an MCP-only group", async () => {
    const Hidden = Action.make("hidden", {
      description: "Not exposed over HTTP",
      success: Schema.String,
      http: false,
    });

    const app = ActionGroup.make({ name: "test" }, Hidden).implement({
      hidden: () => Effect.succeed("hidden"),
    });

    expect(ActionHttp.make({ apiPath: "/api/actions" }, app.group).api.groups).toEqual({});
    const web = makeTestHttp(app, Layer.empty);
    onTestFinished(() => web.dispose());
    expect((await web.handler(post("/api/actions/hidden"))).status).toBe(404);
  });

  it("serves HTTP-only scalar input and skips MCP compilation for it", async () => {
    const Echo = Action.make("echo", {
      description: "HTTP scalar input",
      input: Schema.String,
      success: Schema.String,
      mcp: false,
    });

    const Hidden = Action.make("hidden", {
      description: "Not exposed over HTTP",
      success: Schema.String,
      http: false,
    });

    const app = ActionGroup.make({ name: "test" }, Echo, Hidden).implement({
      echo: Effect.succeed,
      hidden: () => Effect.succeed("hidden"),
    });

    const options = { apiPath: "/rpc" } as const;
    expect(
      Object.keys(OpenApi.fromApi(ActionHttp.make(options, app.group).api).paths ?? {}),
    ).toEqual(["/rpc/echo"]);
    const web = makeTestHttp(app, Layer.empty, options);
    onTestFinished(() => web.dispose());
    const mcp = makeTestMcp(app, Layer.empty);
    onTestFinished(() => mcp.dispose());
    const response = await web.handler(post("/rpc/echo", "hello"));
    expect(response.status).toBe(200);
    expect(await response.json()).toBe("hello");
    expect((await web.handler(post("/rpc/hidden"))).status).toBe(404);
    expect((await listTools(mcp.handler)).map((tool) => tool.name)).toEqual(["hidden"]);
  });

  it.each([409, undefined])(
    "uses schema HTTP status annotations and native defaults: %s",
    async (status) => {
      const Failure = Schema.TaggedStruct("Failure", { message: Schema.String });

      const Fail = Action.make("fail", {
        description: "Declared failure",
        success: Schema.String,
        errors: [status === undefined ? Failure : Failure.annotate({ httpApiStatus: status })],
      });

      const app = ActionGroup.make({ name: "test" }, Fail).implement({
        fail: () => Effect.fail(Failure.make({ message: "Safe failure" })),
      });

      expect(
        OpenApi.fromApi(ActionHttp.make({ apiPath: "/api/actions" }, app.group).api).paths?.[
          "/api/actions/fail"
        ]?.post?.responses,
      ).toHaveProperty(String(status ?? 500));
      const web = makeTestHttp(app, Layer.empty);
      onTestFinished(() => web.dispose());
      const response = await web.handler(post("/api/actions/fail"));
      expect(response.status).toBe(status ?? 500);
      expect(await response.json()).toEqual(Failure.make({ message: "Safe failure" }));
    },
  );

  it("keeps each declared error's own HTTP status", async () => {
    const Missing = Schema.TaggedStruct("Missing", {}).annotate({ httpApiStatus: 404 });
    const Conflict = Schema.TaggedStruct("Conflict", {}).annotate({ httpApiStatus: 409 });

    const Fail = Action.make("fail", {
      description: "Two failures",
      input: Schema.Struct({ which: Schema.Literals(["missing", "conflict"]) }),
      success: Schema.String,
      errors: [Missing, Conflict],
    });

    const app = ActionGroup.make({ name: "test" }, Fail).implement({
      fail: ({ which }) =>
        which === "missing" ? Effect.fail(Missing.make({})) : Effect.fail(Conflict.make({})),
    });

    const responses = OpenApi.fromApi(ActionHttp.make({ apiPath: "/api/actions" }, app.group).api)
      .paths?.["/api/actions/fail"]?.post?.responses;

    expect(responses).toHaveProperty("404");
    expect(responses).toHaveProperty("409");
    expect(responses).not.toHaveProperty("500");
    const web = makeTestHttp(app, Layer.empty);
    onTestFinished(() => web.dispose());
    const mcp = makeTestMcp(app, Layer.empty);
    onTestFinished(() => mcp.dispose());
    expect((await web.handler(post("/api/actions/fail", { which: "missing" }))).status).toBe(404);
    expect((await web.handler(post("/api/actions/fail", { which: "conflict" }))).status).toBe(409);
    expect(await (await mcp.handler(mcpCall("fail", { which: "conflict" }))).json()).toMatchObject({
      result: { isError: true, content: [{ type: "text", text: '{"_tag":"Conflict"}' }] },
    });
  });

  it("reports a declared error as its encoding over MCP, message field included", async () => {
    class Denied extends Schema.TaggedError<Denied>()("Denied", { message: Schema.String }) {}

    const Fail = Action.make("fail", {
      description: "Error with a message",
      success: Schema.String,
      errors: [Denied],
    });

    const mcp = makeTestMcp(
      ActionGroup.make({ name: "test" }, Fail).implement({
        fail: () => Effect.fail(new Denied({ message: "Owner access required" })),
      }),
      Layer.empty,
    );

    onTestFinished(() => mcp.dispose());
    expect(await (await mcp.handler(mcpCall("fail"))).json()).toMatchObject({
      result: {
        isError: true,
        content: [{ type: "text", text: '{"_tag":"Denied","message":"Owner access required"}' }],
      },
    });
  });

  it("accepts a union of errors for MCP", async () => {
    const Missing = Schema.TaggedStruct("Missing", {}).annotate({ httpApiStatus: 404 });
    const Conflict = Schema.TaggedStruct("Conflict", {}).annotate({ httpApiStatus: 409 });

    const Fail = Action.make("fail", {
      description: "Union failure",
      success: Schema.String,
      errors: [Schema.Union([Missing, Conflict])],
    });

    const app = ActionGroup.make({ name: "test" }, Fail).implement({
      fail: () => Effect.fail(Conflict.make({})),
    });

    const mcp = makeTestMcp(app, Layer.empty);
    onTestFinished(() => mcp.dispose());
    expect(await (await mcp.handler(mcpCall("fail"))).json()).toMatchObject({
      result: { isError: true, content: [{ type: "text", text: '{"_tag":"Conflict"}' }] },
    });
  });

  it("keeps schema refs valid when nesting documents in OpenAPI", () => {
    const Item = Schema.Struct({ id: Schema.String }).annotate({ identifier: "Item" });

    const Read = Action.make("read", {
      description: "Referenced schema",
      success: Schema.Struct({ first: Item, second: Item }),
    });

    expectReferencesResolve(
      Schema.decodeUnknownSync(Schema.Json)(
        OpenApi.fromApi(
          ActionHttp.make({ apiPath: "/api/actions" }, ActionGroup.make({ name: "test" }, Read))
            .api,
        ),
      ),
      "#/components/schemas/",
    );
  });

  it.each(["Node", "acme/Node~x", "Node % 雪"])(
    "publishes recursive MCP input and output with resolvable references: %s",
    async (identifier) => {
      interface Node {
        readonly name: string;
        readonly children: ReadonlyArray<Node>;
      }

      const Node: Schema.Codec<Node> = Schema.Struct({
        name: Schema.String,
        children: Schema.Array(Schema.suspend(() => Node)),
      }).annotate({ identifier });

      const Tree = Action.make("tree", {
        description: "Recursive object",
        input: Node,
        success: Node,
      });

      const web = makeTestMcp(
        ActionGroup.make({ name: "test" }, Tree).implement({ tree: Effect.succeed }),
        Layer.empty,
      );

      onTestFinished(() => web.dispose());
      const tools = await listTools(web.handler);
      expect(tools).toHaveLength(1);
      const tool = tools[0];

      if (tool === undefined) throw new Error("Missing tree tool");
      expect(tool.inputSchema.type).toBe("object");

      const definitions = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.JsonObject))(
        tool.inputSchema.$defs,
      );

      expect(definitions[identifier]).toMatchObject({ type: "object" });
      expectReferencesResolve(Schema.decodeUnknownSync(Schema.Json)(tool.inputSchema), "#/$defs/");
      expectReferencesResolve(Schema.decodeUnknownSync(Schema.Json)(tool.outputSchema), "#/$defs/");

      const value = { name: "root", children: [{ name: "leaf", children: [] }] };
      const response = await web.handler(mcpCall("tree", value));
      expect(await response.json()).toMatchObject({
        result: { isError: false, structuredContent: { value } },
      });
    },
  );

  it("publishes nested MCP references without rewriting definitions", async () => {
    const Item = Schema.Struct({ id: Schema.String }).annotate({ identifier: "Item" });

    const Nested = Action.make("nested", {
      description: "Nested references",
      input: Schema.Struct({ item: Item }),
      success: Schema.Struct({ first: Item, second: Item }),
    });

    const web = makeTestMcp(
      ActionGroup.make({ name: "test" }, Nested).implement({
        nested: ({ item }) => Effect.succeed({ first: item, second: item }),
      }),
      Layer.empty,
    );

    onTestFinished(() => web.dispose());
    const tools = await listTools(web.handler);
    const tool = tools[0];

    if (tool === undefined) throw new Error("Missing nested tool");
    expect(tool.inputSchema).toMatchObject({
      properties: { item: { $ref: "#/$defs/Item" } },
      $defs: { Item: { type: "object" } },
    });
    expectReferencesResolve(Schema.decodeUnknownSync(Schema.Json)(tool.inputSchema), "#/$defs/");
    expectReferencesResolve(Schema.decodeUnknownSync(Schema.Json)(tool.outputSchema), "#/$defs/");
  });

  it.each([Schema.String, Schema.Struct({})])(
    "rejects non-object MCP input at ActionMcp.layer, not action definition",
    (input) => {
      const Invalid = Action.make("invalid", {
        description: "Unusable MCP input",
        input,
        success: Schema.String,
      });

      const app = ActionGroup.make({ name: "test" }, Invalid).implement({
        invalid: () => Effect.succeed("unused"),
      });

      expect(() =>
        ActionMcp.layer(
          { protocols: [McpProtocol.v2026_07_28], name: "test", version: "0", path: "/mcp" },
          app,
        ),
      ).toThrow("invalid: MCP input must have an object root");
    },
  );

  it("serves scalar declared errors on both transports; MCP shows them as text", async () => {
    const Scalar = Action.make("scalar", {
      description: "Scalar error",
      success: Schema.String,
      errors: [Schema.String],
    });

    const app = ActionGroup.make({ name: "test" }, Scalar).implement({
      scalar: () => Effect.fail("failure"),
    });

    const web = makeTestHttp(app, Layer.empty);
    onTestFinished(() => web.dispose());
    const mcp = makeTestMcp(app, Layer.empty);
    onTestFinished(() => mcp.dispose());
    const response = await web.handler(post("/api/actions/scalar"));
    expect(response.status).toBe(500);
    expect(await response.json()).toBe("failure");
    expect(await (await mcp.handler(mcpCall("scalar"))).json()).toMatchObject({
      result: { isError: true, content: [{ type: "text", text: '"failure"' }] },
    });
  });

  it("encodes output and optional input correctly through native MCP", async () => {
    const Encode = Action.make("encode", {
      description: "Output transform",
      input: Schema.Struct({ value: Schema.optionalKey(Schema.FiniteFromString) }),
      success: Schema.FiniteFromString,
    });

    const web = makeTestMcp(
      ActionGroup.make({ name: "test" }, Encode).implement({
        encode: ({ value }) => Effect.succeed(value ?? 42),
      }),
      Layer.empty,
    );

    onTestFinished(() => web.dispose());
    const response = await web.handler(mcpCall("encode"));
    expect(await response.text()).toContain('"structuredContent":{"value":"42"}');
  });

  it("reports invalid MCP arguments through the native InvalidParams path, never as a declared failure", async () => {
    const Echo = Action.make("echo", {
      description: "Number",
      input: Schema.Struct({ value: Schema.FiniteFromString }),
      success: Schema.Finite,
    });

    const web = makeTestMcp(
      ActionGroup.make({ name: "test" }, Echo).implement({
        echo: ({ value }) => Effect.succeed(value),
      }),
      Layer.empty,
    );

    onTestFinished(() => web.dispose());
    // This McpServer snapshot presents InvalidParams from a tool as an isError result carrying the message.
    const reply = await (await web.handler(mcpCall("echo", { value: "nope" }))).json();
    expect(reply).toMatchObject({ result: { isError: true } });
    expect(reply).not.toHaveProperty("result.structuredContent");
    expect(JSON.stringify(reply)).toContain("Expected a finite number");
  });

  it("turns invalid output and defects into sanitized native failures on both transports", async () => {
    const Broken = Action.make("broken", { description: "Bad output", success: Schema.Finite });
    const Boom = Action.make("boom", { description: "Defect", success: Schema.String });

    const app = ActionGroup.make({ name: "test" }, Broken, Boom).implement({
      broken: () => Effect.succeed(Infinity),
      boom: () => Effect.die(new Error("secret database password")),
    });

    const web = makeTestHttp(app, Layer.empty);
    onTestFinished(() => web.dispose());
    const mcp = makeTestMcp(app, Layer.empty);
    onTestFinished(() => mcp.dispose());

    // HttpApi renders a response-encoding failure as an empty 400 and a defect as an
    // empty 500; the native McpServer reports both as a generic isError tool result.
    for (const [name, status] of [
      ["broken", 400],
      ["boom", 500],
    ] as const) {
      const http = await web.handler(post(`/api/actions/${name}`));
      expect(http.status).toBe(status);
      expect(await http.text()).toBe("");
      const reply = await (await mcp.handler(mcpCall(name))).text();
      expect(reply).toContain('"isError":true');
      expect(reply).toContain("internal server error");
      expect(reply).not.toContain("secret");
    }
  });

  it("lowers declaration schemas to JSON identically on both transports", async () => {
    const Stamp = Action.make("stamp", {
      description: "Date round trip",
      input: Schema.Struct({ d: Schema.Date }),
      success: Schema.Struct({ d: Schema.Date }),
    });

    const app = ActionGroup.make({ name: "test" }, Stamp).implement({ stamp: Effect.succeed });
    const iso = "1970-01-01T00:00:00.000Z";
    const web = makeTestHttp(app, Layer.empty);
    onTestFinished(() => web.dispose());
    const mcp = makeTestMcp(app, Layer.empty);
    onTestFinished(() => mcp.dispose());
    const tools = await listTools(mcp.handler);
    expect(tools[0]?.inputSchema.properties).toEqual({ d: { type: "string" } });
    const http = await web.handler(post("/api/actions/stamp", { d: iso }));
    expect(http.status).toBe(200);
    expect(await http.json()).toEqual({ d: iso });
    expect(await (await mcp.handler(mcpCall("stamp", { d: iso }))).json()).toMatchObject({
      result: { isError: false, structuredContent: { value: { d: iso } } },
    });
  });

  it("decodes input and encodes output natively over HTTP", async () => {
    const Echo = Action.make("echo", {
      description: "Round-trip a number encoded as a string",
      input: Schema.Struct({ value: Schema.FiniteFromString }),
      success: Schema.FiniteFromString,
    });

    const web = makeTestHttp(
      ActionGroup.make({ name: "test" }, Echo).implement({
        echo: ({ value }) => Effect.succeed(value * 2),
      }),
      Layer.empty,
    );

    onTestFinished(() => web.dispose());
    const response = await web.handler(post("/api/actions/echo", { value: "21" }));
    expect(response.status).toBe(200);
    expect(await response.json()).toBe("42");
    expect((await web.handler(post("/api/actions/echo", { value: "nope" }))).status).toBe(400);
  });

  it("passes HTTP cancellation to the running Effect and finalizes it", async () => {
    const started = Effect.runSync(Deferred.make<void>());
    const stopped = Effect.runSync(Deferred.make<void>());
    const Slow = Action.make("slow", { description: "Wait", success: Schema.String });

    const app = ActionGroup.make({ name: "test" }, Slow).implement({
      slow: () =>
        Deferred.succeed(started, undefined).pipe(
          Effect.andThen(Effect.never),
          Effect.ensuring(Deferred.succeed(stopped, undefined)),
        ),
    });

    const web = makeTestHttp(app, Layer.empty);
    onTestFinished(() => web.dispose());
    const abort = new AbortController();

    const request = new Request("http://localhost/api/actions/slow", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
      signal: abort.signal,
    });

    const running = web.handler(request);
    await Effect.runPromise(Deferred.await(started));
    abort.abort();
    expect((await running).status).toBe(499);
    await Effect.runPromise(Deferred.await(stopped));
  });
});
