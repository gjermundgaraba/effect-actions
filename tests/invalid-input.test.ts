import { describe, expect, it } from "@effect/vitest";
import {
  Context,
  Effect,
  Layer,
  Predicate,
  Redacted,
  Schema,
  SchemaTransformation,
  Stream,
} from "effect";
import { McpSchema } from "effect/ai";
import { HttpClientResponse, HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { HttpApiClient, HttpApiSchema, OpenApi } from "effect/http-api";
import * as Action from "../src/Action.js";
import * as ActionCli from "../src/ActionCli.js";
import * as ActionHttp from "../src/ActionHttp.js";
import * as ActionMcp from "../src/ActionMcp.js";
import * as ActionToolkit from "../src/ActionToolkit.js";
import * as Testing from "../src/Testing.js";
import { exec, printed } from "./cli-services.js";
import { serve } from "./serve.js";
import { mcpRequest, post, rawToolCall, send } from "./requests.js";

class Rejected extends Schema.TaggedError<Rejected>()(
  "Rejected",
  { error: Schema.String },
  { httpApiStatus: 409 },
) {}

const Echo = Action.make("echo", {
  description: "Echo",
  readOnly: false,
  caller: Action.Anyone,
  input: { value: Schema.Finite },
  success: Schema.Finite,
  error: [Rejected],
});

const Http = ActionHttp.make([Echo]);

/** The message of the `InvalidInput` a response carries: Effect's words, so assert on its path. */
const invalidInput = async (response: Response) =>
  Schema.decodeUnknownSync(Action.InvalidInput)(await response.json()).message;

/** The issues a call's failure lists, when it is an `InvalidInput`. */
const issuesOf = (failure: Action.BuiltIn) =>
  Predicate.isTagged(failure, "InvalidInput") ? failure.issues : undefined;

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

  const malformed = await web.handler(post("/api/echo", { value: "secret input" }));
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

it.effect(
  "serves an input annotated with another encoding as JSON, to the binding's client too",
  () =>
    Effect.gen(function* () {
      // Annotations `HttpApi` would read as a form or a text body, which needs no preflight.
      const encodings = [
        HttpApiSchema.asFormUrlEncoded(),
        HttpApiSchema.asJson({ contentType: "text/plain" }),
      ];

      for (const encoding of encodings) {
        const Rename = Action.make("rename", {
          description: "Rename",
          readOnly: false,
          caller: Action.Anyone,
          input: Schema.Struct({ name: Schema.String }).pipe(encoding),
          success: Schema.String,
        });

        const Renaming = ActionHttp.make([Rename]);

        const app = Action.implement(Rename, ({ name }) => Effect.succeed(name));

        yield* Effect.gen(function* () {
          for (const [type, body] of [
            ["application/x-www-form-urlencoded", "name=Ada"],
            ["text/plain", '{"name":"Ada"}'],
          ] as const) {
            const refused = yield* send(
              new Request("http://localhost/api/rename", {
                method: "POST",
                headers: { "content-type": type },
                body,
              }),
            );

            expect(refused.status).toBe(415);
          }

          const client = yield* ActionHttp.client(Renaming);

          expect(yield* client.rename({ name: "Ada" })).toBe("Ada");
        }).pipe(Effect.provide(Testing.layer(ActionHttp.layer(Renaming, app))));
      }
    }),
);

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

it.effect(
  "refuses undeclared input fields on the server, nested ones too; every typed client drops them",
  () =>
    Effect.gen(function* () {
      const seen: Array<unknown> = [];

      const Save = Action.make("save", {
        description: "Save",
        readOnly: false,
        caller: Action.Anyone,
        input: { value: Schema.Finite, owner: Schema.Struct({ id: Schema.String }) },
        success: Schema.Finite,
      });

      const SaveHttp = ActionHttp.make([Save]);

      const app = Action.implement(Save, (input) => Effect.sync(() => seen.push(input)));

      // As the OpenAPI document says: the input is closed, at its root and nested.
      const input = OpenApi.fromApi(SaveHttp.api).paths["/api/save"]?.post?.requestBody?.content[
        "application/json"
      ]?.schema;

      expect(input).toMatchObject({
        additionalProperties: false,
        properties: { owner: { additionalProperties: false } },
      });

      yield* Effect.gen(function* () {
        const save = (body: Schema.Json) => send(post("/api/save", body));
        const refusal = HttpClientResponse.schemaBodyJson(Action.InvalidInput);

        const extra = yield* save({ value: 1, owner: { id: "a" }, admin: true });
        expect(extra.status).toBe(400);
        expect((yield* refusal(extra)).message).toContain('at ["admin"]');

        const nested = yield* save({ value: 1, owner: { id: "a", role: "admin" } });
        expect(nested.status).toBe(400);
        expect((yield* refusal(nested)).message).toContain('at ["owner"]["role"]');

        expect(seen).toEqual([]);

        // A wider object type-checks, as TypeScript allows; every typed client sends only the
        // declared fields: this one, the native one and the MCP test client.
        const wider = { value: 1, owner: { id: "a", role: "admin" }, admin: true };

        yield* (yield* ActionHttp.client(SaveHttp)).save(wider);
        yield* (yield* HttpApiClient.make(SaveHttp.api)).save({ payload: wider });
        yield* (yield* Testing.mcpClient([Save])).save(wider);
      }).pipe(
        Effect.provide(
          Testing.layer(
            Layer.merge(
              ActionHttp.layer(SaveHttp, app),
              ActionMcp.layerHttp(app, { name: "test", version: "0" }),
            ),
          ),
        ),
      );

      expect(seen).toEqual(Array.from({ length: 3 }, () => ({ value: 1, owner: { id: "a" } })));
    }),
);

it("refuses undeclared fields in the input only: a wider success is encoded to its fields", async () => {
  const Profile = Action.make("profile", {
    description: "A profile, from a record holding more",
    readOnly: true,
    caller: Action.Anyone,
    success: { id: Schema.String },
  });

  // A handler may return a wider value, as TypeScript allows: the encoding keeps its fields.
  const stored = { id: "a", passwordHash: "secret" };

  const web = serve(
    ActionHttp.layer(
      ActionHttp.make([Profile]),
      Action.implement(Profile, () => Effect.succeed(stored)),
    ),
  );

  const response = await web.handler(post("/api/profile"));

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ id: "a" });
});

it("answers InvalidInput on every binding and every layer of one router", async () => {
  const Other = Action.make("other", {
    description: "Other",
    readOnly: true,
    caller: Action.Anyone,
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

  for (const path of ["/api/echo", "/api/other", "/second/other"]) {
    const response = await web.handler(post(path, { value: "not a number" }));

    expect(response.status).toBe(400);
    expect(await invalidInput(response)).toContain('at ["value"]');
  }
});

const decodeMcp = Schema.decodeUnknownSync(Schema.Struct({ result: McpSchema.CallToolResult }));

it("answers a handler's own InvalidInput as declared", async () => {
  const app = Action.implement(Echo, ({ value }) =>
    value > 10
      ? Effect.fail(new Action.InvalidInput({ message: "Too large" }))
      : Effect.succeed(value),
  );

  const web = serve(ActionHttp.layer(Http, app));

  const http = await web.handler(post("/api/echo", { value: 11 }));
  expect(http.status).toBe(400);
  expect(await invalidInput(http)).toBe("Too large");
});

it.effect("names each issue of input that does not decode by its path, on every InvalidInput", () =>
  Effect.gen(function* () {
    const Order = Action.make("order", {
      description: "Order",
      readOnly: false,
      caller: Action.Anyone,
      input: {
        kind: Schema.Literal("order"),
        lines: Schema.Array(Schema.Struct({ sku: Schema.String, count: Schema.Finite })),
      },
      success: Schema.String,
    });

    const app = Action.implement(Order, ({ lines }) =>
      lines.length === 0
        ? Effect.fail(
            new Action.InvalidInput({
              message: "An order needs a line",
              issues: [{ path: ["lines"], message: "Expected a line" }],
            }),
          )
        : Effect.succeed("ordered"),
    );

    const Http = ActionHttp.make([Order]);

    /** The `InvalidInput` the routes answer `input` with. */
    const answered = (input: Parameters<typeof post>[1]) =>
      Effect.flatMap(send(post("/api/order", input)), (response) => response.json).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(Action.InvalidInput)),
        Effect.provide(Testing.layer(ActionHttp.layer(Http, app))),
      );

    const nested = {
      kind: "order",
      lines: [
        { sku: "a", count: 1 },
        { sku: "b", count: "two" },
      ],
    };

    // Each issue apart, its path the keys and indexes from the input's root.
    const http = yield* answered({ ...nested, note: "extra" });

    expect(http.issues).toHaveLength(2);
    expect(http.issues?.map(({ path }) => path)).toContainEqual(["lines", 1, "count"]);
    expect(http.issues?.map(({ path }) => path)).toContainEqual(["note"]);
    // The message stays the schema's description of them all.
    expect(http.message).toContain('at ["lines"][1]["count"]');

    // `HttpApiBuilder` decodes a payload through a union, which reports a wrong top-level
    // literal as the whole expected shape: one issue for it. The lines are ones the handler
    // takes, so the issue is the schema's.
    const literal = yield* answered({ kind: "refund", lines: [{ sku: "a", count: 1 }] });

    expect(literal.issues).toHaveLength(1);

    // A handler's own issues are sent as it names them.
    const own = yield* answered({ kind: "order", lines: [] });

    expect(own.issues).toEqual([{ path: ["lines"], message: "Expected a line" }]);

    // In process, where the input's own type is passed.
    const client = yield* Action.client(app);

    const inProcess = yield* Effect.flip(
      client.order({ kind: "order", lines: [{ sku: "a", count: Number.NaN }] }),
    );

    expect(issuesOf(inProcess)?.map(({ path }) => path)).toEqual([["lines", 0, "count"]]);

    // From a command, printed as the JSON HTTP sends.
    const [, , stderr] = yield* printed(
      exec(ActionCli.command(app, Order), ["--kind", "order", "--lines", '[{"sku":"a"}]']),
    );

    expect(stderr.join("\n")).toContain('"path":["lines",0,"count"]');

    // The OpenAPI document declares them on the 400 every endpoint answers.
    const document = OpenApi.fromApi(Http.api);

    expect(document.paths["/api/order"]?.post?.responses["400"]).toMatchObject({
      content: {
        "application/json": { schema: { $ref: "#/components/schemas/InvalidInputEncoded" } },
      },
    });
    expect(document.components.schemas["InvalidInputEncoded"]).toMatchObject({
      properties: {
        issues: { type: "array", items: { required: ["path", "message"] } },
      },
      required: ["_tag", "message"],
    });
  }),
);

it.effect("answers a schema failure of one's own as the surfaces answer input", () =>
  Effect.gen(function* () {
    // Input the application decodes itself, such as a header, refused as an action's is.
    const refused = yield* Effect.flip(
      Schema.decodeUnknownEffect(Schema.Struct({ tenant: Schema.String, page: Schema.Finite }))({
        tenant: "secret-tenant",
        page: "two",
      }).pipe(Effect.mapError(Action.InvalidInput.fromSchemaError)),
    );

    expect(refused).toBeInstanceOf(Action.InvalidInput);
    expect(refused.issues).toMatchObject([{ path: ["page"] }]);
    expect(refused.issues?.[0]?.message).toContain("number");
    expect(refused.message).toContain('at ["page"]');
    // Never a value sent.
    expect(JSON.stringify(refused)).not.toContain("two");
  }),
);

it.effect("names a symbol key of an issue's path as its string form, which JSON can carry", () =>
  Effect.gen(function* () {
    const secret = Symbol("secret");

    const failure = yield* Effect.flip(
      Schema.decodeUnknownEffect(Schema.Struct({ [secret]: Schema.String }))({ [secret]: 1 }),
    );

    // Told apart from a string key named `secret`.
    expect(Action.InvalidInput.fromSchemaError(failure).issues?.map(({ path }) => path)).toEqual([
      ["Symbol(secret)"],
    ]);
  }),
);

it.effect(
  "says where input does not decode and what it expects, never a value sent, on every surface",
  () =>
    Effect.gen(function* () {
      const Login = Action.make("login", {
        description: "Log in",
        readOnly: false,
        caller: Action.Anyone,
        input: {
          password: Schema.Redacted(Schema.String.check(Schema.isMinLength(12))),
          pin: Schema.String.check(Schema.isPattern(/^\d{4}$/)),
          count: Schema.Finite,
        },
        success: Schema.String,
      });

      let calls = 0;

      const app = Action.implement(Login, () =>
        Effect.sync(() => {
          calls++;

          return "in";
        }),
      );

      const sent = { password: "hunter2", pin: "pin-secret", count: "count-secret" };
      // An undeclared field, which HTTP and MCP refuse by its path and a Toolkit drops.
      const wider = { ...sent, note: "note-secret" };

      const routes = Layer.merge(
        ActionHttp.layer(ActionHttp.make([Login]), app),
        ActionMcp.layerHttp(app, { name: "test", version: "0" }),
      );

      /** The body the routes answer `request` with. */
      const answered = (request: Request) =>
        Effect.flatMap(send(request), (response) => response.text).pipe(
          Effect.provide(Testing.layer(routes)),
        );

      const http = yield* answered(post("/api/login", wider));
      const mcp = yield* answered(rawToolCall("login", wider));

      const tools = ActionToolkit.make(app);

      const [called] = yield* Effect.flatMap(tools.toolkit, (toolkit) =>
        Effect.flatMap(toolkit.handle("login", wider), Stream.runCollect),
      ).pipe(Effect.provide(tools.layer));

      const [, , stderr] = yield* printed(
        exec(ActionCli.command(app, Login), [
          "--password",
          sent.password,
          "--pin",
          sent.pin,
          "--count",
          sent.count,
        ]),
      );

      // In process, the caller passes the input's own type: values of it that fail its checks.
      const client = yield* Action.client(app);

      const inProcess = yield* Effect.flip(
        client.login({ password: Redacted.make(sent.password), pin: sent.pin, count: Number.NaN }),
      );

      // What each sends back, as JSON: HTTP's body, MCP's tool result, the Toolkit's result for
      // the model, and what the CLI prints. HTTP and MCP describe every issue, the others the first.
      const answers = [http, mcp, JSON.stringify(called?.encodedResult), stderr.join("\n")];

      for (const answer of answers) {
        expect(answer).toContain(
          'Expected a value with a length of at least 12\\n  at [\\"password\\"]',
        );

        for (const value of Object.values(wider)) expect(answer).not.toContain(value);
      }

      for (const answer of [http, mcp]) {
        expect(answer).toContain('at [\\"pin\\"]');
        expect(answer).toContain('at [\\"count\\"]');
        expect(answer).toContain('at [\\"note\\"]');
      }

      // `Action.client` describes every issue too, each by its path.
      expect(inProcess).toBeInstanceOf(Action.InvalidInput);

      for (const path of ['at ["password"]', 'at ["pin"]', 'at ["count"]']) {
        expect(inProcess.message).toContain(path);
      }

      for (const value of [sent.password, sent.pin]) {
        expect(inProcess.message).not.toContain(value);
        expect(JSON.stringify(issuesOf(inProcess))).not.toContain(value);
      }

      // The handler never sees input that does not decode, on any surface.
      expect(calls).toBe(0);
    }),
);

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
    readOnly: false,
    caller: Action.Anyone,
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

  expect(await (await web.handler(post("/api/echo", { value: "7" }))).json()).toBe("7");
  const mcp = decodeMcp(await (await web.handler(rawToolCall("echo", { value: "7" }))).json());
  expect(mcp.result.structuredContent).toBe("7");
  expect(decodes).toBe(2);
  expect(encodes).toBe(2);
});

describe("an action without input", () => {
  const Empty = Action.make("empty", {
    description: "No input",
    readOnly: true,
    caller: Action.Anyone,
  });

  const app = Action.implement(Empty, () => Effect.void);

  it("has the input of one whose input is {}", () => {
    const Braces = Action.make("empty", {
      description: "No input",
      readOnly: true,
      caller: Action.Anyone,
      input: {},
    });

    expect(Braces.input).toBe(Empty.input);
  });

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
  });

  it("is a closed object tool over MCP", async () => {
    const { handler } = web();

    const listed = await (await handler(mcpRequest({ method: "tools/list" }))).json();
    expect(listed).toMatchObject({
      result: { tools: [{ inputSchema: { type: "object", additionalProperties: false } }] },
    });

    const extra = decodeMcp(await (await handler(rawToolCall("empty", { x: 1 }))).json());
    expect(extra.result.isError).toBe(true);
  });
});

it("publishes `success: {}` as the closed empty object", async () => {
  const Empty = Action.make("empty", {
    description: "Empty",
    readOnly: true,
    caller: Action.Anyone,
    success: {},
  });

  const { handler } = serve(
    ActionMcp.layerHttp(
      Action.implement(Empty, () => Effect.succeed({})),
      { name: "test", version: "0" },
    ),
  );

  const listed = await (await handler(mcpRequest({ method: "tools/list" }))).json();
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
