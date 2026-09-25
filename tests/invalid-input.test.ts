import { expect, it, onTestFinished } from "vite-plus/test";
import { Effect, Layer, Schema, SchemaTransformation } from "effect";
import { McpSchema } from "effect/unstable/ai";
import { HttpClientError } from "effect/unstable/http";
import { OpenApi } from "effect/unstable/httpapi";
import * as Action from "../src/Action.js";
import * as ActionHttp from "../src/ActionHttp.js";
import * as ActionMcp from "../src/ActionMcp.js";
import { httpClient, serve } from "./serve.js";
import { rawToolCall } from "./requests.js";

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

/** `Echo`, counting its calls: negative input is rejected, `0` answers an unencodable `Infinity`. */
const counted = () => {
  const calls = { count: 0 };

  const app = Action.implement(Echo, ({ value }) => {
    calls.count++;

    if (value < 0) return Effect.fail(new Rejected({ error: "Negative value" }));

    return Effect.succeed(value === 0 ? Infinity : value);
  });

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

it("answers a result that does not encode with an empty 500, and a declared error as declared", async () => {
  const { app } = counted();
  const web = serve(ActionHttp.layer(Http, app));

  onTestFinished(() => web.dispose());

  const broken = await web.handler(request(0));
  expect(broken.status).toBe(500);
  expect(await broken.text()).toBe("");

  const rejected = await web.handler(request(-1));
  expect(rejected.status).toBe(409);
  expect(await rejected.json()).toEqual(
    Schema.encodeSync(Rejected)(new Rejected({ error: "Negative value" })),
  );

  const results = await Effect.flatMap(httpClient(Http, web), (client) =>
    Effect.all({
      echoed: client.echo({ value: 12 }),
      broken: Effect.flip(client.echo({ value: 0 })),
      rejected: Effect.flip(client.echo({ value: -1 })),
    }),
  ).pipe(Effect.runPromise);

  expect(results.echoed).toBe(12);
  expect(HttpClientError.isHttpClientError(results.broken)).toBe(true);
  expect(HttpClientError.isHttpClientError(results.broken) && results.broken.reason._tag).toBe(
    "DecodeError",
  );
  expect(HttpClientError.isHttpClientError(results.broken) && results.broken.response?.status).toBe(
    500,
  );
  expect(results.rejected).toEqual(new Rejected({ error: "Negative value" }));
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
