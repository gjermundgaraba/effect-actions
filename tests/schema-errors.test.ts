import { expect, it } from "vite-plus/test";
import { Context, Effect, Layer, Schema, SchemaTransformation } from "effect";
import { FetchHttpClient, HttpRouter, HttpServer } from "effect/unstable/http";
import { McpSchema } from "effect/unstable/ai";
import { HttpApiClient } from "effect/unstable/httpapi";
import { Action, ActionGroup, ActionHttp, ActionMcp } from "../src/index.js";

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
  map: (failure) =>
    failure.phase === "output"
      ? new InvalidResponse({ error: "Invalid response" })
      : new InvalidRequest({ error: "Invalid request" }),
} satisfies Action.SchemaErrorPolicy<readonly [typeof InvalidRequest, typeof InvalidResponse]>;
const options = { schemaError };
const actions = ActionGroup.make(
  Action.make("echo", {
    description: "Echo",
    input: Schema.Struct({ value: Schema.Finite }),
    success: Schema.Finite,
    error: [Rejected],
  }),
);
const request = (value: unknown) =>
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
    ActionHttp.layer(app, options).pipe(Layer.provide(HttpServer.layerServices)),
    { disableLogger: true },
  );
  try {
    const malformed = await web.handler(request("secret input"));
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toEqual({ _tag: "InvalidRequest", error: "Invalid request" });
    const invalidJson = await web.handler(
      new Request("http://localhost/api/actions/echo", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{secret",
      }),
    );
    expect(invalidJson.status).toBe(400);
    expect(await invalidJson.json()).toEqual({ _tag: "InvalidRequest", error: "Invalid request" });
    const broken = await web.handler(request(0));
    expect(broken.status).toBe(500);
    expect(await broken.json()).toEqual({ _tag: "InvalidResponse", error: "Invalid response" });
    const rejected = await web.handler(request(-1));
    expect(rejected.status).toBe(409);
    expect(await rejected.json()).toEqual({ _tag: "Rejected", error: "Negative value" });
    const api = ActionHttp.api(actions, options);
    await Effect.gen(function* () {
      const client = yield* HttpApiClient.make(api, { baseUrl: "http://localhost" });
      expect(yield* client.actions.echo({ payload: { value: 12 } })).toBe(12);
      expect(yield* Effect.flip(client.actions.echo({ payload: { value: 0 } }))).toEqual(
        new InvalidResponse({ error: "Invalid response" }),
      );
      expect(yield* Effect.flip(client.actions.echo({ payload: { value: -1 } }))).toEqual(
        new Rejected({ error: "Negative value" }),
      );
    }).pipe(
      Effect.provide(FetchHttpClient.layer),
      Effect.provideService(FetchHttpClient.Fetch, (input, init) =>
        web.handler(new Request(input, init)),
      ),
      Effect.runPromise,
    );
    const document = ActionHttp.openapi(actions, options);
    expect(document.paths?.["/api/actions/echo"]?.post?.responses).toHaveProperty("400");
    expect(document.paths?.["/api/actions/echo"]?.post?.responses).toHaveProperty("500");
  } finally {
    await web.dispose();
  }
});

it("policy middleware does not turn startup services into request fallbacks", async () => {
  class Value extends Context.Service<Value, number>()("policy-test/Value") {}
  const app = actions.implement({ echo: () => Effect.map(Value, (value) => value) });
  const web = HttpRouter.toWebHandler(
    ActionHttp.layer(app, options).pipe(
      Layer.provide(Layer.succeed(Value, 42)),
      Layer.provide(HttpServer.layerServices),
    ),
    { disableLogger: true },
  );
  try {
    // @ts-expect-error Deliberately omit the required request service at runtime.
    const absent = await web.handler(request(1), Context.empty());
    expect(absent.status).toBe(500);
    expect(await absent.text()).toBe("");
    const present = await web.handler(request(1), Context.make(Value, 7));
    expect(await present.json()).toBe(7);
  } finally {
    await web.dispose();
  }
});

it("keeps separate policies isolated on projections of one implementation", async () => {
  const app = actions.implement({ echo: ({ value }) => Effect.succeed(value) });
  const web = HttpRouter.toWebHandler(
    Layer.merge(
      ActionHttp.layer(app, { prefix: "/a", openapiPath: false, ...options }),
      ActionHttp.layer(app, {
        prefix: "/b",
        openapiPath: false,
        schemaError: {
          errors: [InvalidResponse],
          map: () => new InvalidResponse({ error: "Second policy" }),
        },
      }),
    ).pipe(Layer.provide(HttpServer.layerServices)),
    { disableLogger: true },
  );
  try {
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
  } finally {
    await web.dispose();
  }
});

const decodeMcp = Schema.decodeUnknownSync(Schema.Struct({ result: McpSchema.CallToolResult }));

const mcpRequest = (value: unknown) =>
  new Request("http://localhost/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2026-07-28",
      "mcp-method": "tools/call",
      "mcp-name": "echo",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "echo",
        arguments: { value },
        _meta: {
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          "io.modelcontextprotocol/clientCapabilities": {},
          "io.modelcontextprotocol/clientInfo": { name: "policy-test", version: "0" },
        },
      },
    }),
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
  const Http = ActionHttp.configure({ schemaError: policy });
  const web = HttpRouter.toWebHandler(
    Layer.merge(
      Http.layer(app),
      ActionMcp.layer(app, {
        name: "test",
        version: "0",
        schemaError: policy,
      }),
    ).pipe(Layer.provide(HttpServer.layerServices)),
    { disableLogger: true },
  );
  try {
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
    expect(failures.map((failure) => failure.phase)).toEqual([
      "input",
      "input",
      "output",
      "output",
    ]);
    expect(failures.every((failure) => Schema.isSchemaError(failure.cause))).toBe(true);
    const success = await web.handler(mcpRequest(7));
    expect(decodeMcp(await success.json()).result.structuredContent).toEqual({ value: 7 });
    const defect = await web.handler(mcpRequest(-2));
    expect(await defect.text()).not.toContain("private defect");
    expect(failures).toHaveLength(4);
  } finally {
    await web.dispose();
  }
});

it("rejects non-object policy errors at MCP construction", async () => {
  const app = actions.implement({ echo: ({ value }) => Effect.succeed(value) });
  const routes = ActionMcp.layer(app, {
    name: "test",
    version: "0",
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
    Action.make("echo", {
      description: "Count codec operations",
      input: Schema.Struct({ value: number }),
      success: number,
    }),
  );
  const app = group.implement({ echo: ({ value }) => Effect.succeed(value) });
  const web = HttpRouter.toWebHandler(
    Layer.merge(
      ActionHttp.configure({ schemaError }).layer(app),
      ActionMcp.layer(app, { name: "test", version: "0", schemaError }),
    ).pipe(Layer.provide(HttpServer.layerServices)),
    { disableLogger: true },
  );
  try {
    expect(await (await web.handler(request("7"))).json()).toBe("7");
    expect(
      decodeMcp(await (await web.handler(mcpRequest("7"))).json()).result.structuredContent,
    ).toEqual({ value: "7" });
    expect(decodes).toBe(2);
    expect(encodes).toBe(2);
  } finally {
    await web.dispose();
  }
});

it("does not recursively map a broken policy error", async () => {
  let mappings = 0;
  const broken = {
    errors: [Schema.Struct({ _tag: Schema.Literal("Broken"), value: Schema.Finite })],
    map: () => {
      mappings++;
      return { _tag: "Broken" as const, value: Infinity };
    },
  };
  const app = actions.implement({ echo: ({ value }) => Effect.succeed(value) });
  const web = HttpRouter.toWebHandler(
    Layer.merge(
      ActionHttp.configure({ schemaError: broken }).layer(app),
      ActionMcp.layer(app, { name: "test", version: "0", schemaError: broken }),
    ).pipe(Layer.provide(HttpServer.layerServices)),
    { disableLogger: true },
  );
  try {
    const http = await web.handler(request("private"));
    expect(http.status).toBeGreaterThanOrEqual(400);
    expect(await http.text()).not.toContain("private");
    const mcp = await web.handler(mcpRequest("private"));
    expect(await mcp.text()).not.toContain("private");
    expect(mappings).toBe(2);
  } finally {
    await web.dispose();
  }
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
  const Domain = Schema.Struct({ _tag: Schema.Literal("Domain"), value: Schema.Finite });
  const group = ActionGroup.make(
    Action.make("echo", {
      description: "Broken domain error",
      input: Schema.Struct({ value: Schema.Number }),
      success: Schema.Number,
      error: [Domain],
    }),
  );
  const app = group.implement({
    echo: () => Effect.fail({ _tag: "Domain" as const, value: Infinity }),
  });
  const web = HttpRouter.toWebHandler(
    Layer.merge(
      ActionHttp.configure({ schemaError: policy }).layer(app),
      ActionMcp.layer(app, { name: "test", version: "0", schemaError: policy }),
    ).pipe(Layer.provide(HttpServer.layerServices)),
    { disableLogger: true },
  );
  try {
    const http = await web.handler(request(1));
    expect(http.status).toBe(500);
    expect(await http.text()).toBe("");
    const mcp = await web.handler(mcpRequest(1));
    const body = await mcp.text();
    expect(body).not.toContain("Domain");
    expect(body).not.toContain("InvalidResponse");
    expect(mappings).toBe(0);
  } finally {
    await web.dispose();
  }
});

it("ignores unused policy errors when no MCP tools are exposed", async () => {
  const group = ActionGroup.make(
    Action.make("httpOnly", {
      description: "HTTP only",
      success: Schema.Boolean,
      mcp: false,
    }),
  );
  const routes = ActionMcp.layer(group.implement({ httpOnly: () => Effect.succeed(true) }), {
    name: "test",
    version: "0",
    schemaError: { errors: [Schema.String], map: () => "not an MCP error" },
  });
  await Effect.runPromise(
    Layer.build(
      routes.pipe(Layer.provide(HttpRouter.layer), Layer.provide(HttpServer.layerServices)),
    ).pipe(Effect.scoped),
  );
});
