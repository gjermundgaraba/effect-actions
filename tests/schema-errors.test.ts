import { expect, it, onTestFinished } from "vite-plus/test";
import { Effect, Layer, Schema, SchemaTransformation } from "effect";
import { FetchHttpClient, HttpRouter, HttpServer } from "effect/unstable/http";
import { McpProtocol, McpSchema } from "effect/unstable/ai";
import { HttpApiClient, OpenApi } from "effect/unstable/httpapi";
import * as Action from "../src/Action.js";
import * as ActionGroup from "../src/ActionGroup.js";
import * as ActionHttp from "../src/ActionHttp.js";
import * as ActionMcp from "../src/ActionMcp.js";
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

const schemaError = {
  errors: [InvalidRequest, InvalidResponse],
  map: (failure: Action.SchemaFailure) =>
    failure.phase === "output"
      ? new InvalidResponse({ error: "Invalid response" })
      : new InvalidRequest({ error: "Invalid request" }),
};

const Echo = Action.make("echo", {
  description: "Echo",
  input: Schema.Struct({ value: Schema.Finite }),
  success: Schema.Finite,
  errors: [Rejected],
});

// The policy belongs to the group, so a test with its own policy makes its own group.
const echoGroup = <const Name extends string, const Errors extends ReadonlyArray<Action.Codec>>(
  name: Name,
  policy: Action.SchemaErrorPolicy<Errors>,
) => ActionGroup.make({ name, schemaError: policy }, Echo);

const actions = echoGroup("test", schemaError);

const Http = ActionHttp.make({ apiPath: "/api/actions" }, actions);

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
    Http.layer(app).pipe(Layer.provide(HttpServer.layerServices)),
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
  const document = OpenApi.fromApi(Http.api);
  expect(document.paths?.["/api/actions/echo"]?.post?.responses).toHaveProperty("400");
  expect(document.paths?.["/api/actions/echo"]?.post?.responses).toHaveProperty("500");
});

it("answers with each group's own policy inside one adapter", async () => {
  const second = ActionGroup.make(
    {
      name: "second",
      schemaError: {
        errors: [InvalidResponse],
        map: () => new InvalidResponse({ error: "Second policy" }),
      },
    },
    Action.make("other", {
      description: "Other",
      input: Schema.Struct({ value: Schema.Finite }),
      success: Schema.Finite,
    }),
  );

  const both = ActionHttp.make({ apiPath: "/api" }, actions, second);

  const web = HttpRouter.toWebHandler(
    Layer.merge(
      both.layer(actions.implement({ echo: ({ value }) => Effect.succeed(value) })),
      both.layer(second.implement({ other: ({ value }) => Effect.succeed(value) })),
    ).pipe(Layer.provide(HttpServer.layerServices)),
    { disableLogger: true },
  );

  onTestFinished(() => web.dispose());

  for (const [path, status, message] of [
    ["echo", 400, "Invalid request"],
    ["other", 500, "Second policy"],
  ] as const) {
    const response = await web.handler(
      new Request(`http://localhost/api/${path}`, {
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

it("applies the policy over HTTP only; MCP keeps its native argument and result handling", async () => {
  const failures: Action.SchemaFailure[] = [];
  let calls = 0;

  const policy = {
    errors: schemaError.errors,
    map: (failure: Action.SchemaFailure) => {
      failures.push(failure);

      return schemaError.map(failure);
    },
  };

  const recorded = echoGroup("recorded", policy);

  const app = recorded.implement({
    echo: ({ value }) => {
      calls++;

      if (value === -1) return Effect.fail(new Rejected({ error: "Negative value" }));

      if (value === -2) return Effect.die(new Error("private defect"));

      return Effect.succeed(value === 0 ? Infinity : value);
    },
  });

  const recording = ActionHttp.make({ apiPath: "/api/actions" }, recorded);

  const web = HttpRouter.toWebHandler(
    Layer.merge(
      recording.layer(app),
      ActionMcp.layer(
        { protocols: [McpProtocol.v2026_07_28], name: "test", version: "0", path: "/mcp" },
        app,
      ),
    ).pipe(Layer.provide(HttpServer.layerServices)),
    { disableLogger: true },
  );

  onTestFinished(() => web.dispose());

  // Over HTTP the policy answers; over MCP, invalid arguments and results are the
  // native tool errors, and a declared error is rendered like any other.
  for (const [value, tag, message, mcpText] of [
    ["secret input", "InvalidRequest", "Invalid request", "Invalid parameters for tool 'echo'"],
    [0, "InvalidResponse", "Invalid response", "internal server error"],
    [-1, "Rejected", "Negative value", '{"_tag":"Rejected","error":"Negative value"}'],
  ] as const) {
    const http = await web.handler(request(value));
    expect(await http.json()).toMatchObject({ _tag: tag, error: message });
    const mcp = await web.handler(mcpRequest(value));
    expect(mcp.status).toBe(200);
    const { result } = decodeMcp(await mcp.json());
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toBeUndefined();
    const [content] = result.content;
    expect(content?.type).toBe("text");

    if (content?.type === "text") expect(content.text).toContain(mcpText);
  }

  expect(calls).toBe(4); // Neither transport invokes the handler for invalid input.
  expect(failures.map((failure) => failure.phase)).toEqual(["input", "output"]);
  expect(failures.every((failure) => Schema.isSchemaError(failure.cause))).toBe(true);
  const success = await web.handler(mcpRequest(7));
  expect(decodeMcp(await success.json()).result.structuredContent).toEqual({ value: 7 });
  const defect = await web.handler(mcpRequest(-2));
  expect(await defect.text()).not.toContain("private defect");
  expect(failures).toHaveLength(2);
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
    { name: "test", schemaError },
    Action.make("echo", {
      description: "Count codec operations",
      input: Schema.Struct({ value: number }),
      success: number,
    }),
  );

  const app = group.implement({ echo: ({ value }) => Effect.succeed(value) });

  const web = HttpRouter.toWebHandler(
    Layer.merge(
      ActionHttp.make({ apiPath: "/api/actions" }, group).layer(app),
      ActionMcp.layer(
        { protocols: [McpProtocol.v2026_07_28], name: "test", version: "0", path: "/mcp" },
        app,
      ),
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

it("does not recursively map a broken policy error; MCP never maps", async () => {
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

  const app = echoGroup("broken", broken).implement({ echo: ({ value }) => Effect.succeed(value) });

  const web = HttpRouter.toWebHandler(
    Layer.merge(
      ActionHttp.make({ apiPath: "/api/actions" }, app.group).layer(app),
      ActionMcp.layer(
        { protocols: [McpProtocol.v2026_07_28], name: "test", version: "0", path: "/mcp" },
        app,
      ),
    ).pipe(Layer.provide(HttpServer.layerServices)),
    { disableLogger: true },
  );

  onTestFinished(() => web.dispose());
  const http = await web.handler(request("private"));
  expect(http.status).toBe(500);
  expect(await http.text()).toBe("");
  const mcp = await (await web.handler(mcpRequest("private"))).text();
  expect(decodeMcp(JSON.parse(mcp)).result).toMatchObject({ isError: true });
  expect(mcp).not.toContain("private");
  expect(mappings).toBe(1);
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
    { name: "test", schemaError: policy },
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
      ActionHttp.make({ apiPath: "/api/actions" }, app.group).layer(app),
      ActionMcp.layer(
        { protocols: [McpProtocol.v2026_07_28], name: "test", version: "0", path: "/mcp" },
        app,
      ),
    ).pipe(Layer.provide(HttpServer.layerServices)),
    { disableLogger: true },
  );

  onTestFinished(() => web.dispose());
  const http = await web.handler(request(1));
  expect(http.status).toBe(500);
  expect(await http.text()).toBe("");
  const mcp = await web.handler(mcpRequest(1));
  expect(decodeMcp(await mcp.json()).result).toMatchObject({
    isError: true,
    content: [{ type: "text", text: "Tool execution failed due to an internal server error." }],
  });
  expect(mappings).toBe(0);
});
