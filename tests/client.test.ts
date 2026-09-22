import { expect, it, onTestFinished } from "vite-plus/test";
import { Effect, Layer, Schema, SchemaTransformation } from "effect";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpRouter,
  HttpServer,
} from "effect/unstable/http";
import { HttpApiClient, OpenApi } from "effect/unstable/httpapi";
import * as Action from "../src/Action.js";
import * as ActionGroup from "../src/ActionGroup.js";
import * as ActionHttp from "../src/ActionHttp.js";

class Invalid extends Schema.TaggedError<Invalid>()(
  "Invalid",
  { message: Schema.String },
  { httpApiStatus: 500 },
) {}

const actions = ActionGroup.make(
  {
    name: "numbers",
    schemaError: {
      invalid: { schema: Invalid, make: () => new Invalid({ message: "Invalid input" }) },
      internal: { schema: Invalid, make: () => new Invalid({ message: "Invalid output" }) },
    },
  },
  Action.make("double", {
    description: "Transform in both directions",
    access: "write",
    input: Schema.Struct({ value: Schema.FiniteFromString }),
    success: Schema.FiniteFromString,
  }),
  Action.make("ping", { description: "No input", access: "write", success: Schema.Boolean }),
  Action.make("optional", {
    description: "Optional input",
    access: "write",
    input: Schema.Struct({ value: Schema.optional(Schema.Number) }),
    success: Schema.Number,
  }),
  Action.make("hidden", {
    description: "MCP only",
    access: "write",
    success: Schema.String,
    http: false,
  }),
);

const Http = ActionHttp.make({ apiPath: "/rpc" }, actions);

const app = actions.implement({
  double: ({ value }) => Effect.succeed(value === 0 ? Infinity : value * 2),
  ping: () => Effect.succeed(true),
  optional: ({ value }) => Effect.succeed(value ?? 7),
  hidden: () => Effect.succeed("hidden"),
});

it("keeps the client, routes and document on one configuration", async () => {
  const web = HttpRouter.toWebHandler(
    Http.layer([app]).pipe(Layer.provide(HttpServer.layerServices)),
    {
      disableLogger: true,
    },
  );

  const sent: Array<{ url: string; body: unknown; token: string | null }> = [];
  onTestFinished(() => web.dispose());
  const document = OpenApi.fromApi(Http.api);
  expect(document.paths?.["/rpc/numbers/double"]?.post?.responses).toHaveProperty("500");
  expect(document.paths).not.toHaveProperty("/rpc/numbers/hidden");
  expect(Http.api.groups.numbers.endpoints.double).toBeDefined();
  await Effect.gen(function* () {
    const connection = {
      baseUrl: "http://localhost",
      transformClient: (client: HttpClient.HttpClient) =>
        client.pipe(
          HttpClient.mapRequest(HttpClientRequest.setHeader("authorization", "Bearer test")),
        ),
    };

    const client = yield* HttpApiClient.make(Http.api, connection);

    expect(Object.keys(client.numbers).sort()).toEqual(["double", "optional", "ping"]);
    expect(yield* client.numbers.double({ payload: { value: 21 } })).toBe(42);
    expect(yield* client.numbers.ping({ payload: {} })).toBe(true);
    expect(yield* client.numbers.optional({ payload: {} })).toBe(7);
    expect(yield* client.numbers.optional({ payload: { value: 3 } })).toBe(3);
    expect(yield* Effect.flip(client.numbers.double({ payload: { value: 0 } }))).toEqual(
      new Invalid({ message: "Invalid output" }),
    );

    const [value, response] = yield* client.numbers.ping({
      payload: {},
      responseMode: "decoded-and-response",
    });

    expect(value).toBe(true);
    expect(response.status).toBe(200);
  }).pipe(
    Effect.provide(FetchHttpClient.layer),
    Effect.provideService(FetchHttpClient.Fetch, async (input, init) => {
      const request = new Request(input, init);
      sent.push({
        url: request.url,
        body: await request.clone().json(),
        token: request.headers.get("authorization"),
      });

      return web.handler(request);
    }),
    Effect.runPromise,
  );
  expect(sent[0]).toEqual({
    url: "http://localhost/rpc/numbers/double",
    body: { value: "21" },
    token: "Bearer test",
  });
  expect(sent.slice(1, 3).map((request) => request.body)).toEqual([{}, {}]);
});

it("preserves null and explicitly undefined-valued input codecs", async () => {
  const optional = Schema.Struct({ value: Schema.optional(Schema.Number) });

  const undefinedFromString = Schema.Literal("absent").pipe(
    Schema.decodeTo(
      Schema.Undefined,
      SchemaTransformation.transform({
        decode: () => undefined,
        encode: () => "absent" as const,
      }),
    ),
  );

  const group = ActionGroup.make(
    { name: "inputs" },
    Action.make("nullable", {
      description: "Nullable object",
      access: "write",
      input: Schema.NullOr(optional),
      success: Schema.Boolean,
      mcp: false,
    }),
    Action.make("undefinedValue", {
      description: "Undefined is real decoded data",
      access: "write",
      input: undefinedFromString,
      success: Schema.Boolean,
      mcp: false,
    }),
  );

  const bodies: unknown[] = [];
  await Effect.gen(function* () {
    const client = yield* HttpApiClient.make(
      ActionHttp.make({ apiPath: "/api/actions" }, group).api,
      {
        baseUrl: "http://localhost",
      },
    );

    yield* client.inputs.nullable({ payload: null });
    yield* client.inputs.nullable({ payload: {} });
    yield* client.inputs.undefinedValue({ payload: undefined });
  }).pipe(
    Effect.provide(FetchHttpClient.layer),
    Effect.provideService(FetchHttpClient.Fetch, async (input, init) => {
      bodies.push(await new Request(input, init).json());

      return Response.json(true);
    }),
    Effect.runPromise,
  );
  expect(bodies).toEqual([null, {}, "absent"]);
});
