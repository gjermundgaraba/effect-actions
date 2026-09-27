import { describe, expect, it, onTestFinished } from "vite-plus/test";
import { Effect, Layer, Schema, SchemaTransformation } from "effect";
import { McpSchema } from "effect/unstable/ai";
import { OpenApi } from "effect/unstable/httpapi";
import * as Action from "../src/Action.js";
import * as ActionHttp from "../src/ActionHttp.js";
import * as ActionMcp from "../src/ActionMcp.js";
import { httpClient, serve } from "./serve.js";
import { mcpRequest as rpc, rawToolCall } from "./requests.js";

class Rejected extends Schema.TaggedError<Rejected>()(
  "Rejected",
  { error: Schema.String },
  { httpApiStatus: 409 },
) {}

const Echo = Action.make("echo", {
  description: "Echo",
  access: "write",
  input: { value: Schema.Finite },
  success: Schema.Finite,
  errors: [Rejected],
});

const Http = ActionHttp.make([Echo]);

/** The body of a 400: the built-in error, its message the schema's. */
const invalidInput = (message: string) =>
  Schema.encodeSync(Action.InvalidInput)(new Action.InvalidInput({ message }));

const request = (value: Schema.Json, path = "/api/echo") =>
  new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ value }),
  });

/** `Echo`, counting its calls. */
const counted = () => {
  const calls = { count: 0 };

  const app = Action.implement(Echo, ({ value }) =>
    Effect.sync(() => {
      calls.count++;

      return value;
    }),
  );

  return { app, calls };
};

it("answers a request that does not decode with InvalidInput and the schema's message", async () => {
  const { app, calls } = counted();
  const web = serve(ActionHttp.layer(Http, app));

  onTestFinished(() => web.dispose());

  const malformed = await web.handler(request("secret input"));
  expect(malformed.status).toBe(400);
  // The schema's own words, which name the expected type and path but not the value sent.
  expect(await malformed.json()).toEqual(invalidInput('Expected number\n  at ["value"]'));

  const invalidJson = await web.handler(
    new Request("http://localhost/api/echo", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{secret",
    }),
  );

  expect(invalidJson.status).toBe(400);
  expect(await invalidJson.json()).toEqual(invalidInput("Expected a valid JSON body"));
  // The handler never sees input that does not decode.
  expect(calls.count).toBe(0);
});

it("describes every issue of the input in the message", async () => {
  const Pair = Action.make("pair", {
    description: "Pair",
    access: "write",
    input: { left: Schema.Finite, right: Schema.String },
    success: Schema.Finite,
  });

  const web = serve(
    ActionHttp.layer(
      ActionHttp.make([Pair]),
      Action.implement(Pair, ({ left }) => Effect.succeed(left)),
    ),
  );

  onTestFinished(() => web.dispose());

  const response = await web.handler(
    new Request("http://localhost/api/pair", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ left: "one", right: 2 }),
    }),
  );

  expect(response.status).toBe(400);
  const { message } = Schema.decodeUnknownSync(Action.InvalidInput)(await response.json());
  expect(message).toContain('at ["left"]');
  expect(message).toContain('at ["right"]');
});

it("decodes InvalidInput as a typed failure of the client", async () => {
  const { app } = counted();
  const web = serve(ActionHttp.layer(Http, app));

  onTestFinished(() => web.dispose());

  // The client encodes valid input, so the body is replaced on its way to the server.
  const tampered = (request: Request) =>
    web.handler(
      new Request(request.url, {
        method: request.method,
        headers: request.headers,
        body: JSON.stringify({ value: "one" }),
      }),
    );

  const refused = await Effect.flatMap(httpClient(Http, tampered), (client) =>
    client.echo({ value: 1 }),
  ).pipe(
    // `catchTag` compiles only because every endpoint declares the failure.
    Effect.catchTag("InvalidInput", (failure) => Effect.succeed(failure)),
    Effect.runPromise,
  );

  expect(refused).toBeInstanceOf(Action.InvalidInput);
  expect(refused).toHaveProperty("message", 'Expected number\n  at ["value"]');
});

it("declares InvalidInput, Unauthenticated and Forbidden on every endpoint", () => {
  const Other = Action.make("other", {
    description: "Other",
    access: "read",
    success: Schema.Finite,
  });

  const paths = OpenApi.fromApi(ActionHttp.make([Echo, Other]).api).paths;

  expect(Object.keys(paths?.["/api/echo"]?.post?.responses ?? {}).sort()).toEqual([
    "200",
    "400",
    "401",
    "403",
    "409",
  ]);
  expect(Object.keys(paths?.["/api/other"]?.post?.responses ?? {}).sort()).toEqual([
    "200",
    "400",
    "401",
    "403",
  ]);
});

it("answers InvalidInput on every binding and every layer of one router", async () => {
  const Other = Action.make("other", {
    description: "Other",
    access: "read",
    input: { value: Schema.Finite },
    success: Schema.Finite,
  });

  const both = ActionHttp.make([Echo, Other]);
  const second = ActionHttp.make([Other], { prefix: "/second" });
  const other = Action.implement(Other, ({ value }) => Effect.succeed(value));

  const web = serve(
    Layer.mergeAll(
      ActionHttp.layer(
        both,
        Action.implement(Echo, ({ value }) => Effect.succeed(value)),
      ),
      ActionHttp.layer(both, other),
      ActionHttp.layer(second, other),
    ),
  );

  onTestFinished(() => web.dispose());

  for (const path of ["/api/echo", "/api/other", "/second/other"]) {
    const response = await web.handler(request("not a number", path));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual(invalidInput('Expected number\n  at ["value"]'));
  }
});

const decodeMcp = Schema.decodeUnknownSync(Schema.Struct({ result: McpSchema.CallToolResult }));

const mcpRequest = (value: Schema.Json) => rawToolCall("echo", { value });

it("keeps MCP's native argument and result handling", async () => {
  let calls = 0;

  const app = Action.implement(Echo, ({ value }) => {
    calls++;

    if (value === -1) return Effect.fail(new Rejected({ error: "Negative value" }));

    if (value === -2) return Effect.die(new Error("private defect"));

    return Effect.succeed(value === 0 ? Infinity : value);
  });

  const web = serve(
    Layer.merge(
      ActionHttp.layer(Http, app),
      ActionMcp.layerHttp(app, { name: "test", version: "0" }),
    ),
  );

  onTestFinished(() => web.dispose());

  // Over MCP, invalid arguments and results are the native tool errors, and a declared
  // error is rendered like any other.
  for (const [value, mcpText] of [
    ["secret input", "Invalid parameters for tool 'echo'"],
    [0, "internal server error"],
    [-1, '{"_tag":"Rejected","error":"Negative value"}'],
  ] as const) {
    const mcp = await web.handler(mcpRequest(value));
    expect(mcp.status).toBe(200);
    const { result } = decodeMcp(await mcp.json());
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toBeUndefined();
    const [content] = result.content;
    expect(content?.type).toBe("text");

    if (content?.type === "text") expect(content.text).toContain(mcpText);
  }

  expect(calls).toBe(2); // Invalid arguments never reach the handler.
  const success = await web.handler(mcpRequest(7));
  expect(decodeMcp(await success.json()).result.structuredContent).toEqual({ value: 7 });
  const defect = await web.handler(mcpRequest(-2));
  expect(await defect.text()).not.toContain("private defect");
});

it("executes each input/output transformation once per call", async () => {
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

  const Counted = Action.make("echo", {
    description: "Count codec operations",
    access: "write",
    input: { value: number },
    success: number,
  });

  const app = Action.implement(Counted, ({ value }) => Effect.succeed(value));

  const web = serve(
    Layer.merge(
      ActionHttp.layer(ActionHttp.make([Counted]), app),
      ActionMcp.layerHttp(app, { name: "test", version: "0" }),
    ),
  );

  onTestFinished(() => web.dispose());
  expect(await (await web.handler(request("7"))).json()).toBe("7");
  expect(
    decodeMcp(await (await web.handler(mcpRequest("7"))).json()).result.structuredContent,
  ).toEqual({ value: "7" });
  expect(decodes).toBe(2);
  expect(encodes).toBe(2);
});

it("keeps invalid declared-error encoding a defect on both transports", async () => {
  const Domain = Schema.TaggedStruct("Domain", { value: Schema.Finite });
  // Bypass construction checks deliberately; the adapter must reject this value.
  const domainError = Domain.make({ value: Infinity }, { disableChecks: true });

  const BrokenDomain = Action.make("echo", {
    description: "Broken domain error",
    access: "write",
    input: { value: Schema.Number },
    success: Schema.Number,
    errors: [Domain],
  });

  const app = Action.implement(BrokenDomain, () => Effect.fail(domainError));

  const web = serve(
    Layer.merge(
      ActionHttp.layer(ActionHttp.make([BrokenDomain]), app),
      ActionMcp.layerHttp(app, { name: "test", version: "0" }),
    ),
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
});

describe.each([
  ["omitted", Action.make("empty", { description: "No input", access: "read" })],
  ["{}", Action.make("empty", { description: "No input", access: "read", input: {} })],
] as const)("an action whose input is %s", (_, Empty) => {
  const app = Action.implement(Empty, () => Effect.void);

  const web = () => {
    const server = serve(
      Layer.merge(
        ActionHttp.layer(ActionHttp.make([Empty]), app),
        ActionMcp.layerHttp(app, { name: "test", version: "0" }),
      ),
    );

    onTestFinished(() => server.dispose());

    return server;
  };

  it("takes only {} over HTTP, and a body", async () => {
    const { handler } = web();

    const call = (init: RequestInit) =>
      handler(new Request("http://localhost/api/empty", { method: "POST", ...init }));

    const json = { "content-type": "application/json" };

    expect((await call({ headers: json, body: "{}" })).status).toBe(200);
    expect((await call({ headers: json, body: '{"x":1}' })).status).toBe(400);
    expect((await call({})).status).toBe(400);
  });

  it("is a closed object tool over MCP", async () => {
    const { handler } = web();

    const listed = await (await handler(rpc({ method: "tools/list" }))).json();
    expect(listed).toMatchObject({
      result: { tools: [{ inputSchema: { type: "object", additionalProperties: false } }] },
    });

    const extra = decodeMcp(await (await handler(rawToolCall("empty", { x: 1 }))).json());
    expect(extra.result.isError).toBe(true);
  });
});

it("publishes `success: {}` as the closed empty object", async () => {
  const Empty = Action.make("empty", { description: "Empty", access: "read", success: {} });

  const { handler, dispose } = serve(
    ActionMcp.layerHttp(
      Action.implement(Empty, () => Effect.succeed({})),
      { name: "test", version: "0" },
    ),
  );

  onTestFinished(dispose);

  const listed = await (await handler(rpc({ method: "tools/list" }))).json();
  expect(listed).toMatchObject({
    result: {
      tools: [
        {
          outputSchema: { properties: { value: { type: "object", additionalProperties: false } } },
        },
      ],
    },
  });
});
