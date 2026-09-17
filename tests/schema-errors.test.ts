import { expect, it, onTestFinished } from "vite-plus/test";
import { Context, Effect, Layer, Schema, SchemaTransformation } from "effect";
import { FetchHttpClient, HttpRouter, HttpServer } from "effect/unstable/http";
import { McpSchema } from "effect/unstable/ai";
import { HttpApiClient } from "effect/unstable/httpapi";
import { Action, ActionGroup, ActionHttp, ActionMcp } from "../src/index.js";
import { mcpRequest as toolRequest } from "../src/Testing.js";

class InvalidRequest extends Schema.TaggedError<InvalidRequest>()(
  "InvalidRequest",
  { error: Schema.String },
  { httpApiStatus: 400 },
) {}

class InvalidResponse extends Schema.TaggedError<InvalidResponse>()(
  "InvalidResponse",
  { error: Schema.String },
  { httpApiStatus: 500 },
) {}

class Rejected extends Schema.TaggedError<Rejected>()(
  "Rejected",
  { error: Schema.String },
  { httpApiStatus: 409 },
) {}

const schemaError = Action.schemaErrorPolicy({
  errors: [InvalidRequest, InvalidResponse],
  map: (failure) =>
    failure.phase === "output"
      ? new InvalidResponse({ error: "Invalid response" })
      : new InvalidRequest({ error: "Invalid request" }),
});

const openapi = { openapiPath: "/openapi.json" } as const;

const actions = ActionGroup.make(
  "test",
  Action.make("echo", {
    description: "Echo",
    input: Schema.Struct({ value: Schema.Finite }),
    success: Schema.Finite,
    errors: [Rejected],
  }),
);

const Http = ActionHttp.make(actions, { apiPath: "/api/actions", schemaError });

const request = (value: Schema.Json) =>
  new Request("http://localhost/api/actions/echo", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ value }),
  });

it("maps input and output failures and exposes the same error contract to clients", async () => {
  const app = actions.implement({
    echo: ({ value }) =>
      value < 0
        ? Effect.fail(new Rejected({ error: "Negative value" }))
        : Effect.succeed(value === 0 ? Infinity : value),
  });

  const web = HttpRouter.toWebHandler(
    Http.layer(app, openapi).pipe(Layer.provide(HttpServer.layerServices)),
    { disableLogger: true },
  );

  onTestFinished(() => web.dispose());
  const malformed = await web.handler(request("secret input"));
  expect(malformed.status).toBe(400);
  expect(await malformed.json()).toEqual(
    Schema.encodeSync(InvalidRequest)(new InvalidRequest({ error: "Invalid request" })),
  );

  const invalidJson = await web.handler(
    new Request("http://localhost/api/actions/echo", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{secret",
    }),
  );

  expect(invalidJson.status).toBe(400);
  expect(await invalidJson.json()).toEqual(
    Schema.encodeSync(InvalidRequest)(new InvalidRequest({ error: "Invalid request" })),
  );
  const broken = await web.handler(request(0));
  expect(broken.status).toBe(500);
  expect(await broken.json()).toEqual(
    Schema.encodeSync(InvalidResponse)(new InvalidResponse({ error: "Invalid response" })),
  );
  const rejected = await web.handler(request(-1));
  expect(rejected.status).toBe(409);
  expect(await rejected.json()).toEqual(
    Schema.encodeSync(Rejected)(new Rejected({ error: "Negative value" })),
  );
  await Effect.gen(function* () {
    const client = yield* HttpApiClient.make(Http.api, { baseUrl: "http://localhost" });
    expect(yield* client.test.echo({ payload: { value: 12 } })).toBe(12);
    expect(yield* Effect.flip(client.test.echo({ payload: { value: 0 } }))).toEqual(
      new InvalidResponse({ error: "Invalid response" }),
    );
    expect(yield* Effect.flip(client.test.echo({ payload: { value: -1 } }))).toEqual(
      new Rejected({ error: "Negative value" }),
    );
  }).pipe(
    Effect.provide(FetchHttpClient.layer),
    Effect.provideService(FetchHttpClient.Fetch, (input, init) =>
      web.handler(new Request(input, init)),
    ),
    Effect.runPromise,
  );
  const document = Http.openapi();
  expect(document.paths?.["/api/actions/echo"]?.post?.responses).toHaveProperty("400");
  expect(document.paths?.["/api/actions/echo"]?.post?.responses).toHaveProperty("500");
});

it("policy middleware does not turn startup services into request fallbacks", async () => {
  class Value extends Context.Service<Value, number>()("policy-test/Value") {}

  const app = actions.implement({ echo: () => Effect.map(Value, (value) => value) });

  const web = HttpRouter.toWebHandler(
    Http.layer(app, openapi).pipe(
      Layer.provide(Layer.succeed(Value, 42)),
      Layer.provide(HttpServer.layerServices),
    ),
    { disableLogger: true },
  );

  onTestFinished(() => web.dispose());
  // @ts-expect-error Deliberately omit the required request service at runtime.
  const absent = await web.handler(request(1), Context.empty());
  expect(absent.status).toBe(500);
  expect(await absent.text()).toBe("");
  const present = await web.handler(request(1), Context.make(Value, 7));
  expect(await present.json()).toBe(7);
});

it("keeps separate policies isolated on projections of one implementation", async () => {
  const app = actions.implement({ echo: ({ value }) => Effect.succeed(value) });

  const web = HttpRouter.toWebHandler(
    Layer.merge(
      ActionHttp.make(actions, { apiPath: "/a", schemaError }).layer(app, { openapiPath: false }),
      ActionHttp.make(actions, {
        apiPath: "/b",
        schemaError: {
          errors: [InvalidResponse],
          map: () => new InvalidResponse({ error: "Second policy" }),
        },
      }).layer(app, { openapiPath: false }),
    ).pipe(Layer.provide(HttpServer.layerServices)),
    { disableLogger: true },
  );

  onTestFinished(() => web.dispose());

  for (const [path, status, message] of [
    ["a", 400, "Invalid request"],
    ["b", 500, "Second policy"],
  ] as const) {
    const response = await web.handler(
      new Request(`http://localhost/${path}/echo`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
    );

    expect(response.status).toBe(status);
    expect(await response.json()).toMatchObject({ error: message });
  }
});

const decodeMcp = Schema.decodeUnknownSync(Schema.Struct({ result: McpSchema.CallToolResult }));

const mcpRequest = (value: Schema.Json) =>
  toolRequest({
    url: "http://localhost/mcp",
    method: "tools/call",
    params: { name: "echo", arguments: { value } },
  });

it("shares input/output policy with MCP without converting domain errors or defects", async () => {
  const failures: Action.SchemaFailure[] = [];
  let calls = 0;

  const app = actions.implement({
    echo: ({ value }) => {
      calls++;

      if (value === -1) return Effect.fail(new Rejected({ error: "Negative value" }));

      if (value === -2) return Effect.die(new Error("private defect"));

      return Effect.succeed(value === 0 ? Infinity : value);
    },
  });

  const policy = {
    errors: schemaError.errors,
    map: (failure: Action.SchemaFailure) => {
      failures.push(failure);

      return schemaError.map(failure);
    },
  };

  const recording = ActionHttp.make(actions, { apiPath: "/api/actions", schemaError: policy });

  const web = HttpRouter.toWebHandler(
    Layer.merge(
      recording.layer(app, openapi),
      ActionMcp.layer(app, {
        name: "test",
        version: "0",
        path: "/mcp",
        schemaError: policy,
      }),
    ).pipe(Layer.provide(HttpServer.layerServices)),
    { disableLogger: true },
  );

  onTestFinished(() => web.dispose());

  for (const [value, tag] of [
    ["secret input", "InvalidRequest"],
    [0, "InvalidResponse"],
    [-1, "Rejected"],
  ] as const) {
    const http = await web.handler(request(value));
    const mcp = await web.handler(mcpRequest(value));
    expect(mcp.status).toBe(200);
    const { result } = decodeMcp(await mcp.json());
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual(await http.json());
    expect(result.structuredContent).toMatchObject({ _tag: tag });
  }

  expect(calls).toBe(4); // Neither transport invokes the handler for invalid input.
  expect(failures.map((failure) => failure.phase)).toEqual(["input", "input", "output", "output"]);
  expect(failures.every((failure) => Schema.isSchemaError(failure.cause))).toBe(true);
  const success = await web.handler(mcpRequest(7));
  expect(decodeMcp(await success.json()).result.structuredContent).toEqual({ value: 7 });
  const defect = await web.handler(mcpRequest(-2));
  expect(await defect.text()).not.toContain("private defect");
  expect(failures).toHaveLength(4);
});

it("rejects non-object policy errors at MCP construction", async () => {
  const app = actions.implement({ echo: ({ value }) => Effect.succeed(value) });

  const routes = ActionMcp.layer(app, {
    name: "test",
    version: "0",
    path: "/mcp",
    schemaError: { errors: [Schema.String], map: () => "invalid" },
  });

  await expect(
    Effect.runPromise(
      Layer.build(
        routes.pipe(Layer.provide(HttpRouter.layer), Layer.provide(HttpServer.layerServices)),
      ).pipe(Effect.scoped),
    ),
  ).rejects.toThrow("Schema-error policy: MCP error must have an object root");
});

it("executes each input/output transformation once with a policy enabled", async () => {
  let decodes = 0;
  let encodes = 0;

  const number = Schema.String.pipe(
    Schema.decodeTo(
      Schema.Number,
      SchemaTransformation.transform({
        decode: (value) => {
          decodes++;

          return Number(value);
        },
        encode: (value) => {
          encodes++;

          return String(value);
        },
      }),
    ),
  );

  const group = ActionGroup.make(
    "test",
    Action.make("echo", {
      description: "Count codec operations",
      input: Schema.Struct({ value: number }),
      success: number,
    }),
  );

  const app = group.implement({ echo: ({ value }) => Effect.succeed(value) });

  const web = HttpRouter.toWebHandler(
    Layer.merge(
      ActionHttp.make(group, { apiPath: "/api/actions", schemaError }).layer(app, openapi),
      ActionMcp.layer(app, {
        name: "test",
        version: "0",
        path: "/mcp",
        schemaError,
      }),
    ).pipe(Layer.provide(HttpServer.layerServices)),
    { disableLogger: true },
  );

  onTestFinished(() => web.dispose());
  expect(await (await web.handler(request("7"))).json()).toBe("7");
  expect(
    decodeMcp(await (await web.handler(mcpRequest("7"))).json()).result.structuredContent,
  ).toEqual({ value: "7" });
  expect(decodes).toBe(2);
  expect(encodes).toBe(2);
});

it("does not recursively map a broken policy error", async () => {
  let mappings = 0;

  const Broken = Schema.TaggedStruct("Broken", { value: Schema.Finite });
  // Construct outside the callback so the failure must occur during error encoding.
  const brokenError = Broken.make({ value: Infinity }, { disableChecks: true });

  const broken = {
    errors: [Broken],
    map: () => {
      mappings++;

      return brokenError;
    },
  };

  const app = actions.implement({ echo: ({ value }) => Effect.succeed(value) });

  const web = HttpRouter.toWebHandler(
    Layer.merge(
      ActionHttp.make(actions, { apiPath: "/api/actions", schemaError: broken }).layer(
        app,
        openapi,
      ),
      ActionMcp.layer(app, {
        name: "test",
        version: "0",
        path: "/mcp",
        schemaError: broken,
      }),
    ).pipe(Layer.provide(HttpServer.layerServices)),
    { disableLogger: true },
  );

  onTestFinished(() => web.dispose());
  const http = await web.handler(request("private"));
  expect(http.status).toBe(500);
  expect(await http.text()).toBe("");
  const mcp = await web.handler(mcpRequest("private"));
  expect(await mcp.json()).toEqual({
    jsonrpc: "2.0",
    id: 1,
    error: Schema.encodeSync(McpSchema.InternalError)(
      new McpSchema.InternalError({ message: "Internal error" }),
    ),
  });
  expect(mappings).toBe(2);
});

it("keeps invalid declared-error encoding a defect on both transports", async () => {
  let mappings = 0;

  const policy = {
    errors: schemaError.errors,
    map: (failure: Action.SchemaFailure) => {
      mappings++;

      return schemaError.map(failure);
    },
  };

  const Domain = Schema.TaggedStruct("Domain", { value: Schema.Finite });
  // Bypass construction checks deliberately; the adapter must reject this value.
  const domainError = Domain.make({ value: Infinity }, { disableChecks: true });

  const group = ActionGroup.make(
    "test",
    Action.make("echo", {
      description: "Broken domain error",
      input: Schema.Struct({ value: Schema.Number }),
      success: Schema.Number,
      errors: [Domain],
    }),
  );

  const app = group.implement({
    echo: () => Effect.fail(domainError),
  });

  const web = HttpRouter.toWebHandler(
    Layer.merge(
      ActionHttp.make(app.group, { apiPath: "/api/actions", schemaError: policy }).layer(
        app,
        openapi,
      ),
      ActionMcp.layer(app, {
        name: "test",
        version: "0",
        path: "/mcp",
        schemaError: policy,
      }),
    ).pipe(Layer.provide(HttpServer.layerServices)),
    { disableLogger: true },
  );

  onTestFinished(() => web.dispose());
  const http = await web.handler(request(1));
  expect(http.status).toBe(500);
  expect(await http.text()).toBe("");
  const mcp = await web.handler(mcpRequest(1));
  expect(await mcp.json()).toEqual({
    jsonrpc: "2.0",
    id: 1,
    error: Schema.encodeSync(McpSchema.InternalError)(
      new McpSchema.InternalError({ message: "Internal error" }),
    ),
  });
  expect(mappings).toBe(0);
});

it("ignores unused policy errors when no MCP tools are exposed", async () => {
  const group = ActionGroup.make(
    "test",
    Action.make("httpOnly", {
      description: "HTTP only",
      success: Schema.Boolean,
      mcp: false,
    }),
  );

  const routes = ActionMcp.layer(group.implement({ httpOnly: () => Effect.succeed(true) }), {
    name: "test",
    version: "0",
    path: "/mcp",
    schemaError: { errors: [Schema.String], map: () => "not an MCP error" },
  });

  await Effect.runPromise(
    Layer.build(
      routes.pipe(Layer.provide(HttpRouter.layer), Layer.provide(HttpServer.layerServices)),
    ).pipe(Effect.scoped),
  );
});
