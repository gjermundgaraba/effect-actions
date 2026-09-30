import { describe, expect, it } from "vite-plus/test";
import { Context, Effect, Layer, Schema, SchemaTransformation } from "effect";
import { McpSchema } from "effect/ai";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { HttpApiClient, OpenApi } from "effect/http-api";
import * as Action from "../src/Action.js";
import * as ActionHttp from "../src/ActionHttp.js";
import * as ActionMcp from "../src/ActionMcp.js";
import * as Testing from "../src/Testing.js";
import { against, httpClient, serve } from "./serve.js";
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

/** The message of the `InvalidInput` a response carries: Effect's words, so assert on its path. */
const invalidInput = async (response: Response) =>
  Schema.decodeUnknownSync(Action.InvalidInput)(await response.json()).message;

const request = (value: Schema.Json, path = "/api/echo") =>
  new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ value }),
  });

/** `Echo`, counting its calls. */
const counted = () => {
  const calls = { count: 0 };

  const app = Action.implement(
    Echo,
    ({ value }) =>
      Effect.sync(() => {
        calls.count++;

        return value;
      }),
    Action.allowAll,
  );

  return { app, calls };
};

it("answers a request that does not decode with InvalidInput and the schema's message", async () => {
  const { app, calls } = counted();
  const web = serve(ActionHttp.layer(Http, app));

  const malformed = await web.handler(request("secret input"));
  expect(malformed.status).toBe(400);
  // The schema's own words, which name the path but not the value sent.
  const message = await invalidInput(malformed);
  expect(message).toContain('at ["value"]');
  expect(message).not.toContain("secret");

  const invalidJson = await web.handler(
    new Request("http://localhost/api/echo", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{secret",
    }),
  );

  expect(invalidJson.status).toBe(400);
  expect(await invalidInput(invalidJson)).not.toContain("secret");
  // The handler never sees input that does not decode.
  expect(calls.count).toBe(0);
});

it("answers 415 to every body a page may send without a preflight, so a cross-site write never runs", async () => {
  class Session extends Context.Service<Session, string>()("invalid-input/Session") {}

  // A dashboard on another site, signed in with a session cookie that CORS lets it send.
  const cookie = HttpRouter.middleware<{ provides: Session }>()((route) =>
    Effect.flatMap(HttpServerRequest.HttpServerRequest, (request) =>
      request.cookies["session"] === "s3cr3t"
        ? Effect.provideService(route, Session, "alice")
        : Effect.succeed(HttpServerResponse.empty({ status: 401 })),
    ),
  );

  const { app, calls } = counted();

  const web = serve(
    Layer.mergeAll(
      ActionHttp.layer(Http, app).pipe(Layer.provide(cookie.layer)),
      HttpRouter.cors({ allowedOrigins: ["https://app.example.com"], credentials: true }),
    ),
  );

  const body = JSON.stringify({ value: 1 });

  const from = (origin: string, headers: Record<string, string> = {}, sent: Blob | string = body) =>
    new Request("http://localhost/api/echo", {
      method: "POST",
      headers: { origin, cookie: "session=s3cr3t", ...headers },
      body: sent,
    });

  // `fetch` sends no content type at all for an untyped `Blob`, and so no preflight.
  const untyped = from("https://evil.example.com", {}, new Blob([body]));
  expect(untyped.headers.get("content-type")).toBeNull();
  expect((await web.handler(untyped)).status).toBe(415);

  // Nor for the other types a page sends without a preflight.
  for (const type of [
    "text/plain",
    "application/x-www-form-urlencoded",
    "multipart/form-data; boundary=x",
  ]) {
    expect(
      (await web.handler(from("https://evil.example.com", { "content-type": type }))).status,
    ).toBe(415);
  }

  expect(calls.count).toBe(0);

  // Typed as JSON, a page on another origin is preflighted, and CORS decides; the call runs,
  // whatever parameters the type carries.
  for (const type of ["application/json", "application/json; charset=utf-8"]) {
    const typed = from("https://app.example.com", { "content-type": type });
    expect((await web.handler(typed)).status).toBe(200);
  }

  expect(calls.count).toBe(2);
});

it("names the content type a 415 refuses, or none", async () => {
  const web = serve(ActionHttp.layer(Http, counted().app));

  const send = async (headers: Record<string, string>) => {
    const response = await web.handler(
      new Request("http://localhost/api/echo", {
        method: "POST",
        headers,
        body: new Blob([JSON.stringify({ value: 1 })]),
      }),
    );

    return [response.status, await response.text()];
  };

  expect(await send({})).toEqual([415, "Unsupported content-type: none"]);
  expect(await send({ "content-type": "text/plain" })).toEqual([
    415,
    "Unsupported content-type: text/plain",
  ]);
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
      Action.implement(Pair, ({ left }) => Effect.succeed(left), Action.allowAll),
    ),
  );

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

it("refuses undeclared input fields on the server, nested ones too; every typed client drops them", async () => {
  const seen: Array<unknown> = [];

  const Save = Action.make("save", {
    description: "Save",
    access: "write",
    input: { value: Schema.Finite, owner: Schema.Struct({ id: Schema.String }) },
    success: Schema.Finite,
  });

  const SaveHttp = ActionHttp.make([Save]);

  const app = Action.implement(
    Save,
    (input) => Effect.sync(() => seen.push(input)),
    Action.allowAll,
  );

  const web = serve(
    Layer.merge(
      ActionHttp.layer(SaveHttp, app),
      ActionMcp.layerHttp(app, { name: "test", version: "0" }),
    ),
  );

  // As the OpenAPI document says: the input is closed, at its root and nested.
  const input = OpenApi.fromApi(SaveHttp.api).paths["/api/save"]?.post?.requestBody?.content[
    "application/json"
  ]?.schema;

  expect(input).toMatchObject({
    additionalProperties: false,
    properties: { owner: { additionalProperties: false } },
  });

  const save = (body: Schema.Json) =>
    web.handler(
      new Request("http://localhost/api/save", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );

  const extra = await save({ value: 1, owner: { id: "a" }, admin: true });
  expect(extra.status).toBe(400);
  expect(await invalidInput(extra)).toContain('at ["admin"]');

  const nested = await save({ value: 1, owner: { id: "a", role: "admin" } });
  expect(nested.status).toBe(400);
  expect(await invalidInput(nested)).toContain('at ["owner"]["role"]');

  expect(seen).toEqual([]);

  // A wider object type-checks, as TypeScript allows; every typed client sends only the
  // declared fields: this one, the native one and the MCP test client.
  const wider = { value: 1, owner: { id: "a", role: "admin" }, admin: true };

  await against(
    web,
    Effect.gen(function* () {
      yield* (yield* ActionHttp.client(SaveHttp)).save(wider);
      yield* (yield* HttpApiClient.make(SaveHttp.api)).save({ payload: wider });
      yield* (yield* Testing.mcpClient([Save])).save(wider);
    }),
  );

  expect(seen).toEqual(Array.from({ length: 3 }, () => ({ value: 1, owner: { id: "a" } })));
});

it("refuses undeclared fields in the input only: a wider success is encoded to its fields", async () => {
  const Profile = Action.make("profile", {
    description: "A profile, from a record holding more",
    access: "read",
    success: { id: Schema.String },
  });

  // A handler may return a wider value, as TypeScript allows: the encoding keeps its fields.
  const stored = { id: "a", passwordHash: "secret" };

  const web = serve(
    ActionHttp.layer(
      ActionHttp.make([Profile]),
      Action.implement(Profile, () => Effect.succeed(stored), Action.allowAll),
    ),
  );

  const response = await web.handler(
    new Request("http://localhost/api/profile", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    }),
  );

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ id: "a" });
});

it("decodes InvalidInput as a typed failure of the client", async () => {
  const { app } = counted();
  const web = serve(ActionHttp.layer(Http, app));

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
  expect(refused).toHaveProperty("message", expect.stringContaining('at ["value"]'));
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
  const other = Action.implement(Other, ({ value }) => Effect.succeed(value), Action.allowAll);

  const web = serve(
    Layer.mergeAll(
      ActionHttp.layer(
        both,
        Action.implement(Echo, ({ value }) => Effect.succeed(value), Action.allowAll),
      ),
      ActionHttp.layer(both, other),
      ActionHttp.layer(second, other),
    ),
  );

  for (const path of ["/api/echo", "/api/other", "/second/other"]) {
    const response = await web.handler(request("not a number", path));

    expect(response.status).toBe(400);
    expect(await invalidInput(response)).toContain('at ["value"]');
  }
});

const decodeMcp = Schema.decodeUnknownSync(Schema.Struct({ result: McpSchema.CallToolResult }));

const mcpRequest = (value: Schema.Json) => rawToolCall("echo", { value });

it("answers a handler's own InvalidInput as declared, over HTTP and MCP", async () => {
  const app = Action.implement(
    Echo,
    ({ value }) =>
      value > 10
        ? Effect.fail(new Action.InvalidInput({ message: "Too large" }))
        : Effect.succeed(value),
    Action.allowAll,
  );

  const web = serve(
    Layer.merge(
      ActionHttp.layer(Http, app),
      ActionMcp.layerHttp(app, { name: "test", version: "0" }),
    ),
  );

  const http = await web.handler(request(11));
  expect(http.status).toBe(400);
  expect(await invalidInput(http)).toBe("Too large");

  const { result } = decodeMcp(await (await web.handler(mcpRequest(11))).json());
  expect(result.isError).toBe(true);
  expect(result.content).toEqual([
    { type: "text", text: '{"_tag":"InvalidInput","message":"Too large"}' },
  ]);
});

it("keeps MCP's native argument and result handling", async () => {
  let calls = 0;

  const app = Action.implement(
    Echo,
    ({ value }) => {
      calls++;

      if (value === -1) return Effect.fail(new Rejected({ error: "Negative value" }));

      if (value === -2) return Effect.die(new Error("private defect"));

      return Effect.succeed(value === 0 ? Infinity : value);
    },
    Action.allowAll,
  );

  const web = serve(
    Layer.merge(
      ActionHttp.layer(Http, app),
      ActionMcp.layerHttp(app, { name: "test", version: "0" }),
    ),
  );

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
  expect(decodeMcp(await success.json()).result.structuredContent).toBe(7);
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

  const app = Action.implement(Counted, ({ value }) => Effect.succeed(value), Action.allowAll);

  const web = serve(
    Layer.merge(
      ActionHttp.layer(ActionHttp.make([Counted]), app),
      ActionMcp.layerHttp(app, { name: "test", version: "0" }),
    ),
  );

  expect(await (await web.handler(request("7"))).json()).toBe("7");
  expect(
    decodeMcp(await (await web.handler(mcpRequest("7"))).json()).result.structuredContent,
  ).toBe("7");
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

  const app = Action.implement(BrokenDomain, () => Effect.fail(domainError), Action.allowAll);

  const web = serve(
    Layer.merge(
      ActionHttp.layer(ActionHttp.make([BrokenDomain]), app),
      ActionMcp.layerHttp(app, { name: "test", version: "0" }),
    ),
  );

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
  const app = Action.implement(Empty, () => Effect.void, Action.allowAll);

  const web = () => {
    const server = serve(
      Layer.merge(
        ActionHttp.layer(ActionHttp.make([Empty]), app),
        ActionMcp.layerHttp(app, { name: "test", version: "0" }),
      ),
    );

    return server;
  };

  it("takes only {} over HTTP, and a body", async () => {
    const { handler } = web();

    const call = (init: RequestInit) =>
      handler(new Request("http://localhost/api/empty", { method: "POST", ...init }));

    const json = { "content-type": "application/json" };

    expect((await call({ headers: json, body: "{}" })).status).toBe(200);
    expect((await call({ headers: json, body: '{"x":1}' })).status).toBe(400);
    const missing = await call({ headers: json });
    expect(missing.status).toBe(400);
    // The body decodes as the built-in `InvalidInput`, not any other 400.
    await expect(invalidInput(missing)).resolves.not.toBe("");
    // Without a content type, the request is not JSON at all.
    expect((await call({})).status).toBe(415);
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

  const { handler } = serve(
    ActionMcp.layerHttp(
      Action.implement(Empty, () => Effect.succeed({}), Action.allowAll),
      { name: "test", version: "0" },
    ),
  );

  const listed = await (await handler(rpc({ method: "tools/list" }))).json();
  expect(listed).toMatchObject({
    result: {
      tools: [
        {
          outputSchema: { type: "object", additionalProperties: false },
        },
      ],
    },
  });
});
