import { describe, expect, it, onTestFinished } from "vite-plus/test";
import { Deferred, Effect, JsonPointer, Layer, Schema } from "effect";
import { McpSchema } from "effect/unstable/ai";
import { HttpRouter } from "effect/unstable/http";
import { Action, ActionGroup, ActionHttp, ActionMcp } from "../src/index.js";
import { makeTestHttp, makeTestMcp } from "./server.js";
import { mcpRequest } from "../src/Testing.js";
import { post } from "./requests.js";

const mcpCall = (name: string, args: unknown = {}) =>
  mcpRequest("tools/call", { name, arguments: args });

const listTools = async (handler: (request: Request) => Promise<Response>) => {
  const response = await handler(mcpRequest("tools/list"));
  expect(response.status).toBe(200);
  const reply = Schema.decodeUnknownSync(
    Schema.Struct({ result: Schema.Struct({ tools: Schema.Array(McpSchema.Tool) }) }),
  )(await response.json());
  return reply.result.tools;
};

const expectReferencesResolve = (document: unknown, prefix: string) => {
  const refs: string[] = [];
  const visit = (value: unknown) => {
    if (Array.isArray(value)) return value.forEach(visit);
    if (value === null || typeof value !== "object") return;
    for (const [key, item] of Object.entries(value)) {
      if (key === "$ref" && typeof item === "string") refs.push(item);
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
    const app = ActionGroup.make(Hidden).implement({ hidden: () => Effect.succeed("hidden") });
    expect(() => ActionHttp.api(app)).toThrow("No HTTP-enabled actions");
    const web = makeTestHttp(app, Layer.empty);
    onTestFinished(() => web.dispose());
    expect((await web.handler(post("/api/actions/hidden"))).status).toBe(404);
    expect((await web.handler(new Request("http://localhost/openapi.json"))).status).toBe(404);
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
    const app = ActionGroup.make(Echo, Hidden).implement({
      echo: Effect.succeed,
      hidden: () => Effect.succeed("hidden"),
    });
    const options = { prefix: "/rpc", openapiPath: "/schema.json" } as const;
    expect(Object.keys(ActionHttp.openapi(app, options).paths ?? {})).toEqual(["/rpc/echo"]);
    const web = makeTestHttp(app, Layer.empty, options);
    onTestFinished(() => web.dispose());
    const mcp = makeTestMcp(app, Layer.empty);
    onTestFinished(() => mcp.dispose());
    const response = await web.handler(post("/rpc/echo", "hello"));
    expect(response.status).toBe(200);
    expect(await response.json()).toBe("hello");
    expect((await web.handler(new Request("http://localhost/schema.json"))).status).toBe(200);
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
        error: [status === undefined ? Failure : Failure.annotate({ httpApiStatus: status })],
      });
      const app = ActionGroup.make(Fail).implement({
        fail: () => Effect.fail(Failure.make({ message: "Safe failure" })),
      });
      expect(ActionHttp.openapi(app).paths?.["/api/actions/fail"]?.post?.responses).toHaveProperty(
        String(status ?? 500),
      );
      const web = makeTestHttp(app, Layer.empty);
      onTestFinished(() => web.dispose());
      const response = await web.handler(post("/api/actions/fail"));
      expect(response.status).toBe(status ?? 500);
      expect(await response.json()).toEqual({ _tag: "Failure", message: "Safe failure" });
    },
  );

  it("keeps each declared error's own HTTP status", async () => {
    const Missing = Schema.TaggedStruct("Missing", {}).annotate({ httpApiStatus: 404 });
    const Conflict = Schema.TaggedStruct("Conflict", {}).annotate({ httpApiStatus: 409 });
    const Fail = Action.make("fail", {
      description: "Two failures",
      input: Schema.Struct({ which: Schema.Literals(["missing", "conflict"]) }),
      success: Schema.String,
      error: [Missing, Conflict],
    });
    const app = ActionGroup.make(Fail).implement({
      fail: ({ which }) =>
        which === "missing" ? Effect.fail(Missing.make({})) : Effect.fail(Conflict.make({})),
    });
    const responses = ActionHttp.openapi(app).paths?.["/api/actions/fail"]?.post?.responses;
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
      result: { isError: true, structuredContent: { _tag: "Conflict" } },
    });
  });

  it("accepts a union of object errors for MCP", async () => {
    const Missing = Schema.TaggedStruct("Missing", {}).annotate({ httpApiStatus: 404 });
    const Conflict = Schema.TaggedStruct("Conflict", {}).annotate({ httpApiStatus: 409 });
    const Fail = Action.make("fail", {
      description: "Union failure",
      success: Schema.String,
      error: [Schema.Union([Missing, Conflict])],
    });
    const app = ActionGroup.make(Fail).implement({ fail: () => Effect.fail(Conflict.make({})) });
    const mcp = makeTestMcp(app, Layer.empty);
    onTestFinished(() => mcp.dispose());
    expect(await (await mcp.handler(mcpCall("fail"))).json()).toMatchObject({
      result: { isError: true, structuredContent: { _tag: "Conflict" } },
    });
  });

  it("keeps schema refs valid when nesting documents in OpenAPI", () => {
    const Item = Schema.Struct({ id: Schema.String }).annotate({ identifier: "Item" });
    const Read = Action.make("read", {
      description: "Referenced schema",
      success: Schema.Struct({ first: Item, second: Item }),
    });
    expectReferencesResolve(ActionHttp.openapi(ActionGroup.make(Read)), "#/components/schemas/");
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
        ActionGroup.make(Tree).implement({ tree: Effect.succeed }),
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
      expectReferencesResolve(tool.inputSchema, "#/$defs/");
      expectReferencesResolve(tool.outputSchema, "#/$defs/");

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
      ActionGroup.make(Nested).implement({
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
    expectReferencesResolve(tool.inputSchema, "#/$defs/");
    expectReferencesResolve(tool.outputSchema, "#/$defs/");
  });

  it.each([Schema.String, Schema.Struct({})])(
    "rejects non-object MCP input during Layer construction, not action definition",
    async (input) => {
      const Invalid = Action.make("invalid", {
        description: "Unusable MCP input",
        input,
        success: Schema.String,
      });
      const app = ActionGroup.make(Invalid).implement({ invalid: () => Effect.succeed("unused") });
      const layer = ActionMcp.layer(app, { name: "test", version: "0" }).pipe(
        Layer.provide(HttpRouter.layer),
      );
      await expect(Effect.runPromise(Layer.build(layer).pipe(Effect.scoped))).rejects.toThrow(
        "invalid: MCP input must have an object root",
      );
    },
  );

  it("rejects declared errors that do not encode to objects for MCP; HTTP still serves them", async () => {
    const Scalar = Action.make("scalar", {
      description: "Scalar error",
      success: Schema.String,
      error: [Schema.String],
    });
    const app = ActionGroup.make(Scalar).implement({ scalar: () => Effect.fail("failure") });
    const layer = ActionMcp.layer(app, { name: "test", version: "0" }).pipe(
      Layer.provide(HttpRouter.layer),
    );
    await expect(Effect.runPromise(Layer.build(layer).pipe(Effect.scoped))).rejects.toThrow(
      "scalar: MCP error must have an object root",
    );
    const web = makeTestHttp(app, Layer.empty);
    onTestFinished(() => web.dispose());
    const response = await web.handler(post("/api/actions/scalar"));
    expect(response.status).toBe(500);
    expect(await response.json()).toBe("failure");
  });

  it("encodes output and optional input correctly through native MCP", async () => {
    const Encode = Action.make("encode", {
      description: "Output transform",
      input: Schema.Struct({ value: Schema.optionalKey(Schema.FiniteFromString) }),
      success: Schema.FiniteFromString,
    });
    const web = makeTestMcp(
      ActionGroup.make(Encode).implement({ encode: ({ value }) => Effect.succeed(value ?? 42) }),
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
      ActionGroup.make(Echo).implement({ echo: ({ value }) => Effect.succeed(value) }),
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
    const app = ActionGroup.make(Broken, Boom).implement({
      broken: () => Effect.succeed(Infinity),
      boom: () => Effect.die(new Error("secret database password")),
    });
    const web = makeTestHttp(app, Layer.empty);
    onTestFinished(() => web.dispose());
    const mcp = makeTestMcp(app, Layer.empty);
    onTestFinished(() => mcp.dispose());
    // HttpApi renders a response-encoding failure as an empty 400 and a defect as an empty 500.
    for (const [name, status] of [
      ["broken", 400],
      ["boom", 500],
    ] as const) {
      const http = await web.handler(post(`/api/actions/${name}`));
      expect(http.status).toBe(status);
      expect(await http.text()).toBe("");
      const reply = await (await mcp.handler(mcpCall(name))).text();
      expect(reply).toContain('"code":-32603');
      expect(reply).not.toContain("secret");
    }
  });

  it("lowers declaration schemas to JSON identically on both transports", async () => {
    const Stamp = Action.make("stamp", {
      description: "Date round trip",
      input: Schema.Struct({ d: Schema.Date }),
      success: Schema.Struct({ d: Schema.Date }),
    });
    const app = ActionGroup.make(Stamp).implement({ stamp: Effect.succeed });
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
      ActionGroup.make(Echo).implement({ echo: ({ value }) => Effect.succeed(value * 2) }),
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
    const app = ActionGroup.make(Slow).implement({
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

it("can leave OpenAPI registration to the host without disabling action routes", async () => {
  const app = ActionGroup.make(
    Action.make("ping", {
      description: "Ping",
      success: Schema.String,
    }),
  ).implement({ ping: () => Effect.succeed("pong") });
  const web = makeTestHttp(app, Layer.empty, { openapiPath: false });
  onTestFinished(() => web.dispose());
  const response = await web.handler(
    new Request("http://localhost/api/actions/ping", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    }),
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toBe("pong");
  expect((await web.handler(new Request("http://localhost/openapi.json"))).status).toBe(404);
});
