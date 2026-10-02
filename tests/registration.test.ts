import { describe, expect, it } from "vite-plus/test";
import { Context, Deferred, Effect, JsonPointer, Layer, Predicate, Schema } from "effect";
import { McpSchema, McpServer, Tool, Toolkit } from "effect/ai";
import { OpenApi } from "effect/http-api";
import * as Action from "../src/Action.js";
import * as ActionCli from "../src/ActionCli.js";
import * as ActionHttp from "../src/ActionHttp.js";
import * as ActionMcp from "../src/ActionMcp.js";
import * as ActionToolkit from "../src/ActionToolkit.js";
import { makeTestHttp, makeTestMcp } from "./server.js";
import { mcpRequest, post, rawToolCall } from "./requests.js";
import { against, serve } from "./serve.js";

it("serves MCP 2026-07-28 only over HTTP and passes the native server options through", async () => {
  const web = serve(
    ActionMcp.layerHttp([], {
      name: "configured",
      version: "0",
      path: "/mcp",
      description: "A configured server",
      websiteUrl: "https://example.com",
      icons: [{ src: "https://example.com/icon.png" }],
      extensions: { "io.example/extension": {} },
    }),
  );

  const discovered = await web.handler(mcpRequest({ method: "server/discover" }));

  expect(discovered.status).toBe(200);
  expect(await discovered.json()).toMatchObject({
    result: {
      _meta: {
        "io.modelcontextprotocol/serverInfo": {
          name: "configured",
          version: "0",
          description: "A configured server",
          websiteUrl: "https://example.com",
          icons: [{ src: "https://example.com/icon.png" }],
        },
      },
      supportedVersions: ["2026-07-28"],
      capabilities: { extensions: { "io.example/extension": {} } },
    },
  });

  // A 2025 client opens with `initialize` and no protocol header; nothing answers it.
  const legacy = await web.handler(
    new Request("http://localhost/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "legacy", version: "0" },
        },
      }),
    }),
  );

  expect(legacy.status).toBe(400);
  expect(await legacy.json()).toMatchObject({ error: { code: -32020 } });
});

const listTools = async (handler: (request: Request) => Promise<Response>) => {
  const response = await handler(mcpRequest({ method: "tools/list" }));
  expect(response.status).toBe(200);

  const reply = Schema.decodeUnknownSync(
    Schema.Struct({ result: Schema.Struct({ tools: Schema.Array(McpSchema.Tool) }) }),
  )(await response.json());

  return reply.result.tools;
};

describe("descriptions", () => {
  it("describes each action on every surface by its contract's description", async () => {
    const Describe = Action.make("describe", {
      description: "What this action does, for every caller.",
      access: "read",
    });

    const app = Action.implement(Describe, () => Effect.void, Action.allowAll);
    const { description } = Describe;

    const operation = OpenApi.fromApi(ActionHttp.make([Describe]).api).paths["/api/describe"]?.post;
    const [tool] = await listTools(makeTestMcp(app).handler);

    expect({
      http: operation?.description,
      mcp: tool?.description,
      toolkit: ActionToolkit.make(app).toolkit.tools.describe.description,
      cli: ActionCli.command(app, Describe).description,
    }).toEqual({ http: description, mcp: description, toolkit: description, cli: description });
  });
});

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
  it("serves scalar input over HTTP", async () => {
    const Echo = Action.make("echo", {
      description: "HTTP scalar input",
      access: "write",
      input: Schema.String,
      success: Schema.String,
    });

    const web = makeTestHttp(Action.implement(Echo, Effect.succeed, Action.allowAll), {
      prefix: "/rpc",
    });

    const response = await web.handler(post("/rpc/echo", "hello"));
    expect(response.status).toBe(200);
    expect(await response.json()).toBe("hello");
  });

  it("sends a declared error without an HTTP status as 422", async () => {
    const Failure = Schema.TaggedStruct("Failure", { message: Schema.String });

    const Fail = Action.make("fail", {
      description: "Declared failure",
      access: "write",
      success: Schema.String,
      errors: [Failure],
    });

    const apps = Action.implement(
      [Fail],
      {
        fail: () => Effect.fail(Failure.make({ message: "Safe failure" })),
      },
      Action.allowAll,
    );

    expect(
      OpenApi.fromApi(ActionHttp.make([Fail]).api).paths["/api/fail"]?.post?.responses,
    ).toHaveProperty("422");
    const web = makeTestHttp(apps);

    const response = await web.handler(post("/api/fail"));
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual(Failure.make({ message: "Safe failure" }));

    // The client reads the status from the same binding, so it decodes the error.
    const failure = await against(
      web,
      Effect.flip(
        Effect.flatMap(ActionHttp.client(ActionHttp.make([Fail])), (client) => client.fail()),
      ),
    );

    expect(failure).toEqual(Failure.make({ message: "Safe failure" }));
  });

  const Missing = Schema.TaggedStruct("Missing", {}).annotate({ httpApiStatus: 404 });
  const Conflict = Schema.TaggedStruct("Conflict", {}).annotate({ httpApiStatus: 409 });

  it.each([
    ["listed", [Missing, Conflict]],
    ["in a union", [Schema.Union([Missing, Conflict])]],
  ])("keeps each declared error's own HTTP status, %s", async (_, errors) => {
    const Fail = Action.make("fail", {
      description: "Two failures",
      access: "write",
      input: Schema.Struct({ which: Schema.Literals(["missing", "conflict"]) }),
      success: Schema.String,
      errors,
    });

    const apps = Action.implement(
      [Fail],
      {
        fail: ({ which }) =>
          which === "missing" ? Effect.fail(Missing.make({})) : Effect.fail(Conflict.make({})),
      },
      Action.allowAll,
    );

    const Http = ActionHttp.make([Fail]);
    const responses = OpenApi.fromApi(Http.api).paths["/api/fail"]?.post?.responses;

    expect(Object.keys(responses ?? {}).sort()).toEqual(["200", "400", "401", "403", "404", "409"]);
    const web = makeTestHttp(apps);

    expect((await web.handler(post("/api/fail", { which: "missing" }))).status).toBe(404);
    expect((await web.handler(post("/api/fail", { which: "conflict" }))).status).toBe(409);
    expect(
      await against(
        web,
        Effect.flatMap(ActionHttp.client(Http), (client) =>
          Effect.flip(client.fail({ which: "conflict" })),
        ),
      ),
    ).toEqual(Conflict.make({}));
  });

  it("sends a union with a status of its own at that status, and a member without one as 422", () => {
    const Late = Schema.TaggedStruct("Late", {});

    const statuses = (errors: ReadonlyArray<Schema.Codec<unknown, unknown>>) =>
      Object.keys(
        OpenApi.fromApi(
          ActionHttp.make([Action.make("fail", { description: "", access: "write", errors })]).api,
        ).paths["/api/fail"]?.post?.responses ?? {},
      ).sort();

    expect(statuses([Schema.Union([Missing, Conflict]).annotate({ httpApiStatus: 410 })])).toEqual([
      "200",
      "400",
      "401",
      "403",
      "410",
    ]);
    expect(statuses([Schema.Union([Missing, Late])])).toEqual([
      "200",
      "400",
      "401",
      "403",
      "404",
      "422",
    ]);
  });

  it("carries each action's hints to its MCP and native tools", async () => {
    const Lookup = Action.make("lookup", {
      description: "Look up",
      access: "read",
      hints: { idempotent: true, openWorld: false },
    });

    const Append = Action.make("append", {
      description: "Append",
      access: "write",
      hints: { destructive: false },
    });

    const Wipe = Action.make("wipe", {
      description: "Wipe",
      access: "write",
      hints: { idempotent: true },
    });

    const app = Action.implement(
      [Lookup, Append, Wipe],
      {
        lookup: () => Effect.void,
        append: () => Effect.void,
        wipe: () => Effect.void,
      },
      Action.allowAll,
    );

    const hints = {
      lookup: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      append: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
      wipe: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    };

    const mcp = makeTestMcp(app);

    const listed = await listTools(mcp.handler);
    expect(Object.fromEntries(listed.map((tool) => [tool.name, tool.annotations]))).toMatchObject(
      hints,
    );

    const { tools } = ActionToolkit.make(app).toolkit;
    expect(
      Object.fromEntries(
        Object.entries(tools).map(([name, { annotations }]) => [
          name,
          {
            readOnlyHint: Context.get(annotations, Tool.Readonly),
            destructiveHint: Context.get(annotations, Tool.Destructive),
            idempotentHint: Context.get(annotations, Tool.Idempotent),
            openWorldHint: Context.get(annotations, Tool.OpenWorld),
          },
        ]),
      ),
    ).toEqual(hints);
  });

  it("declares each built-in error once on every tool and endpoint", () => {
    const Declared = Action.make("whoAmI", {
      description: "Name the authenticated principal",
      access: "read",
      success: Schema.String,
    });

    const { tools } = ActionToolkit.make(
      Action.implement(Declared, () => Effect.succeed("ada"), Action.allowAll),
    ).toolkit;

    // Each built-in's JSON decodes to its class: the tool declares all three.
    const builtIns = Schema.Union([Action.InvalidInput, Action.Unauthenticated, Action.Forbidden]);

    for (const error of [
      new Action.InvalidInput(),
      new Action.Unauthenticated(),
      new Action.Forbidden(),
    ]) {
      const json = Schema.encodeSync(Schema.toCodecJson(builtIns))(error);

      expect(Schema.decodeUnknownSync(tools.whoAmI.failureSchema)(json)).toEqual(error);
    }

    const responses = OpenApi.fromApi(ActionHttp.make([Declared]).api).paths["/api/whoAmI"]?.post
      ?.responses;

    expect(Object.keys(responses ?? {}).sort()).toEqual(["200", "400", "401", "403"]);

    // Declared twice, a status would list its error twice, as an `anyOf`.
    for (const [status, error] of [
      ["401", "UnauthenticatedEncoded"],
      ["403", "ForbiddenEncoded"],
    ] as const) {
      expect(responses?.[status]?.content?.["application/json"]?.schema).toEqual({
        $ref: `#/components/schemas/${error}`,
      });
    }
  });

  it("reports a declared error as its encoding over MCP, message field included", async () => {
    class Denied extends Schema.TaggedError<Denied>()("Denied", { message: Schema.String }) {}

    const Fail = Action.make("fail", {
      description: "Error with a message",
      access: "write",
      success: Schema.String,
      errors: [Denied],
    });

    const mcp = makeTestMcp(
      Action.implement(
        [Fail],
        {
          fail: () => Effect.fail(new Denied({ message: "Owner access required" })),
        },
        Action.allowAll,
      ),
    );

    expect(await (await mcp.handler(rawToolCall("fail"))).json()).toMatchObject({
      result: {
        isError: true,
        content: [{ type: "text", text: '{"_tag":"Denied","message":"Owner access required"}' }],
      },
    });
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
        access: "write",
        input: Node,
        success: Node,
      });

      const web = makeTestMcp(Action.implement([Tree], { tree: Effect.succeed }, Action.allowAll));

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
      const response = await web.handler(rawToolCall("tree", value));
      expect(await response.json()).toMatchObject({
        result: { isError: false, structuredContent: value },
      });
    },
  );

  // A tool's arguments have a JSON Schema object root.
  const One = Schema.Struct({ kind: Schema.Literal("one"), id: Schema.String });

  /** One read action per entry of `inputs`, named by its key, without input for `undefined`. */
  const implementations = (inputs: Readonly<Record<string, Action.Any["input"] | undefined>>) =>
    Object.entries(inputs).map(([name, input]) =>
      Action.implement(
        Action.make(name, { description: name, access: "read", input }),
        () => Effect.void,
        Action.allowAll,
      ),
    );

  it("serves input whose JSON Schema is one object, a suspended or declared one included", async () => {
    class Fields extends Schema.Class<Fields>("Fields")({ id: Schema.String }) {}

    // A declared type whose value is JSON as it is, and whose JSON Schema its check states.
    const Declared = Schema.declare(Schema.is(Schema.Struct({ id: Schema.String })), {
      toCodecJson: () => undefined,
    }).check(
      Schema.makeFilter(() => true, {
        toJsonSchema: () => ({ type: "object", properties: { id: { type: "string" } } }),
      }),
    );

    const inputs = {
      none: undefined,
      struct: One,
      identified: One.annotate({ identifier: "One" }),
      optional: Schema.Struct({ id: Schema.optionalKey(One) }),
      record: Schema.Record(Schema.String, Schema.Number),
      class: Fields,
      suspended: Schema.suspend(() => One),
      declared: Declared,
    };

    const tools = await listTools(makeTestMcp(implementations(inputs)).handler);

    expect(tools.map(({ name, inputSchema }) => [name, inputSchema.type])).toEqual(
      Object.keys(inputs).map((name) => [name, "object"]),
    );
  });

  // Checked when the server is made, where the native server would die building the layer.
  it("refuses input that is not one object with keys, naming every such action", () => {
    class NoFields extends Schema.Class<NoFields>("NoFields")({}) {}

    const Other = Schema.Struct({ kind: Schema.Literal("other"), code: Schema.Number });

    const inputs = {
      union: Schema.Union([One, Other]),
      nullable: Schema.NullOr(One),
      // An object to TypeScript, `anyOf` to MCP.
      single: Schema.Union([One]),
      scalar: Schema.String,
      // Compiles to a `$ref` root, which the native server inlines and still rejects.
      named: Schema.String.annotate({ identifier: "Named" }),
      array: Schema.Array(One),
      tuple: Schema.Tuple([Schema.String]),
      // No keys, and accepts any value but `null`.
      anything: Schema.Struct({}),
      fieldless: NoFields,
    };

    const refused = implementations(inputs);

    const status = Action.implement(
      Action.make("status", { description: "Status", access: "read" }),
      () => Effect.void,
      Action.allowAll,
    );

    const options = { name: "test", version: "0" };
    const message = `MCP tool input must be one object with keys, such as a struct: ${Object.keys(inputs).join(", ")}`;

    expect(() => ActionMcp.layerHttp([status, ...refused], options)).toThrow(message);
    expect(() => ActionMcp.runStdio(refused, options)).toThrow(message);
  });

  // An endpoint's registry is its own: native features merged beside it register elsewhere.
  it("serves no native resource, prompt or tool merged beside an endpoint", async () => {
    const Ping = Action.make("ping", { description: "Ping", access: "read" });
    const Native = Toolkit.make(Tool.make("native", { success: Schema.String }));

    const web = serve(
      Layer.mergeAll(
        ActionMcp.layerHttp(
          Action.implement(Ping, () => Effect.void, Action.allowAll),
          { name: "test", version: "0" },
        ),
        McpServer.resource({ uri: "docs://readme", name: "README", content: Effect.succeed("#") }),
        McpServer.prompt({ name: "triage", content: () => Effect.succeed("Triage.") }),
        McpServer.toolkit(Native).pipe(
          Layer.provide(Native.toLayer({ native: () => Effect.succeed("native") })),
        ),
      ),
    );

    const resources = await web.handler(mcpRequest({ method: "resources/list" }));
    const prompts = await web.handler(mcpRequest({ method: "prompts/list" }));

    expect((await listTools(web.handler)).map(({ name }) => name)).toEqual(["ping"]);
    expect(await resources.json()).toMatchObject({ result: { resources: [] } });
    expect(await prompts.json()).toMatchObject({ error: { code: -32601 } });
  });

  it("serves scalar declared errors on both transports; MCP shows them as text", async () => {
    const Scalar = Action.make("scalar", {
      description: "Scalar error",
      access: "write",
      success: Schema.String,
      errors: [Schema.String],
    });

    const apps = Action.implement(
      [Scalar],
      {
        scalar: () => Effect.fail("failure"),
      },
      Action.allowAll,
    );

    const web = makeTestHttp(apps);

    const mcp = makeTestMcp(apps);

    const response = await web.handler(post("/api/scalar"));
    expect(response.status).toBe(422);
    expect(await response.json()).toBe("failure");
    expect(await (await mcp.handler(rawToolCall("scalar"))).json()).toMatchObject({
      result: { isError: true, content: [{ type: "text", text: '"failure"' }] },
    });
  });

  it("turns invalid output and errors, and defects, into sanitized native failures on both transports", async () => {
    const Broken = Action.make("broken", {
      description: "Bad output",
      access: "write",
      success: Schema.Finite,
    });

    const Domain = Schema.TaggedStruct("Domain", { value: Schema.Finite });

    const Refused = Action.make("refused", {
      description: "Bad declared error",
      access: "write",
      success: Schema.String,
      errors: [Domain],
    });

    const Boom = Action.make("boom", {
      description: "Defect",
      access: "write",
      success: Schema.String,
    });

    const apps = Action.implement(
      [Broken, Refused, Boom],
      {
        broken: () => Effect.succeed(Infinity),
        // Construction checks bypassed deliberately: the surface must reject this value.
        refused: () => Effect.fail(Domain.make({ value: Infinity }, { disableChecks: true })),
        boom: () => Effect.die(new Error("secret database password")),
      },
      Action.allowAll,
    );

    const web = makeTestHttp(apps);

    const mcp = makeTestMcp(apps);

    // A result or a declared error that does not encode is a defect, like any other: HTTP
    // answers each with an empty 500, and the native McpServer reports each as a generic
    // isError tool result.
    for (const name of ["broken", "refused", "boom"]) {
      const http = await web.handler(post(`/api/${name}`));
      expect(http.status).toBe(500);
      expect(await http.text()).toBe("");
      const reply = await (await mcp.handler(rawToolCall(name))).text();
      expect(reply).toContain('"isError":true');
      expect(reply).toContain("internal server error");
      expect(reply).not.toContain("secret");
    }
  });

  it("lowers declaration schemas to JSON identically on both transports", async () => {
    const Stamp = Action.make("stamp", {
      description: "Date round trip",
      access: "write",
      input: Schema.Struct({ d: Schema.Date }),
      success: Schema.Struct({ d: Schema.Date }),
    });

    const apps = Action.implement([Stamp], { stamp: Effect.succeed }, Action.allowAll);
    const iso = "1970-01-01T00:00:00.000Z";
    const web = makeTestHttp(apps);

    const mcp = makeTestMcp(apps);

    const tools = await listTools(mcp.handler);
    expect(tools[0]?.inputSchema.properties).toEqual({ d: { type: "string" } });
    const http = await web.handler(post("/api/stamp", { d: iso }));
    expect(http.status).toBe(200);
    expect(await http.json()).toEqual({ d: iso });
    expect(await (await mcp.handler(rawToolCall("stamp", { d: iso }))).json()).toMatchObject({
      result: { isError: false, structuredContent: { d: iso } },
    });
  });

  it("passes HTTP cancellation to the running Effect and finalizes it", async () => {
    const started = Effect.runSync(Deferred.make<void>());
    const stopped = Effect.runSync(Deferred.make<void>());

    const Slow = Action.make("slow", {
      description: "Wait",
      access: "write",
      success: Schema.String,
    });

    const apps = Action.implement(
      [Slow],
      {
        slow: () =>
          Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Effect.never),
            Effect.ensuring(Deferred.succeed(stopped, undefined)),
          ),
      },
      Action.allowAll,
    );

    const web = makeTestHttp(apps);

    const abort = new AbortController();

    const request = new Request("http://localhost/api/slow", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
      signal: abort.signal,
    });

    const running = web.handler(request);
    await Effect.runPromise(Deferred.await(started));
    abort.abort();
    await running;
    // The handler's finalizer ran: the request's interruption reached it.
    await Effect.runPromise(Deferred.await(stopped).pipe(Effect.timeout("1 second")));
  });
});
