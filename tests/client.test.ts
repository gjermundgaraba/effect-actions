import { expect, it, onTestFinished } from "vite-plus/test";
import { Deferred, Effect, Fiber, Layer, Schema, SchemaTransformation } from "effect";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpRouter,
  HttpServer,
} from "effect/unstable/http";
import { Action, ActionGroup, ActionHttp } from "../src/index.js";

class Invalid extends Schema.TaggedError<Invalid>()(
  "Invalid",
  { message: Schema.String },
  { httpApiStatus: 500 },
) {}
const actions = ActionGroup.make(
  Action.make("double", {
    description: "Transform in both directions",
    input: Schema.Struct({ value: Schema.FiniteFromString }),
    success: Schema.FiniteFromString,
  }),
  Action.make("ping", { description: "No input", success: Schema.Boolean }),
  Action.make("optional", {
    description: "Optional input",
    input: Schema.Struct({ value: Schema.optional(Schema.Number) }),
    success: Schema.Number,
  }),
  Action.make("hidden", { description: "MCP only", success: Schema.String, http: false }),
);
const schemaError = {
  errors: [Invalid],
  map: () => new Invalid({ message: "Invalid output" }),
};
const Http = ActionHttp.configure({
  apiPath: "/rpc",
  openapiPath: "/schema",
  schemaError,
});
const app = actions.implement({
  double: ({ value }) => Effect.succeed(value === 0 ? Infinity : value * 2),
  ping: () => Effect.succeed(true),
  optional: ({ value }) => Effect.succeed(value ?? 7),
  hidden: () => Effect.succeed("hidden"),
});

it.each(["configured", "standalone"] as const)(
  "%s client agrees with the route and document configuration",
  async (mode) => {
    const web = HttpRouter.toWebHandler(
      Http.layer(app).pipe(Layer.provide(HttpServer.layerServices)),
      {
        disableLogger: true,
      },
    );
    const sent: Array<{ url: string; body: unknown; token: string | null }> = [];
    onTestFinished(() => web.dispose());
    const response = await web.handler(new Request("http://localhost/schema"));
    expect(response.status).toBe(200);
    const document = Http.openapi(actions);
    expect(await response.json()).toEqual(document);
    expect(document.paths?.["/rpc/double"]?.post?.responses).toHaveProperty("500");
    expect(document.paths).not.toHaveProperty("/rpc/hidden");
    expect(Http.api(actions).groups.actions.endpoints.double).toBeDefined();
    await Effect.gen(function* () {
      const connection = {
        baseUrl: "http://localhost",
        transformClient: (client: HttpClient.HttpClient) =>
          client.pipe(
            HttpClient.mapRequest(HttpClientRequest.setHeader("authorization", "Bearer test")),
          ),
      };
      const client = yield* mode === "configured"
        ? Http.client(actions, connection)
        : ActionHttp.client(actions, {
            ...connection,
            apiPath: "/rpc",
            schemaError,
          });
      expect(Object.keys(client).sort()).toEqual(["double", "optional", "ping"]);
      expect(yield* client.double({ value: 21 })).toBe(42);
      expect(yield* client.ping()).toBe(true);
      expect(yield* client.ping(undefined)).toBe(true);
      expect(yield* client.optional()).toBe(7);
      expect(yield* client.optional(undefined)).toBe(7);
      expect(yield* client.optional({ value: 3 })).toBe(3);
      expect(yield* Effect.flip(client.double({ value: 0 }))).toEqual(
        new Invalid({ message: "Invalid output" }),
      );
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
      url: "http://localhost/rpc/double",
      body: { value: "21" },
      token: "Bearer test",
    });
    expect(sent.slice(1, 5).map((request) => request.body)).toEqual([{}, {}, {}, {}]);
  },
);

it("retains native response validation, transport errors and response transforms", async () => {
  let transformed = 0;
  const call = Effect.gen(function* () {
    const client = yield* Http.client(actions, {
      baseUrl: "http://localhost",
      transformResponse: (effect) =>
        Effect.onExit(effect, () =>
          Effect.sync(() => {
            transformed++;
          }),
        ),
    });
    return yield* Effect.flip(client.ping());
  }).pipe(Effect.provide(FetchHttpClient.layer));
  const malformed = await Effect.runPromise(
    call.pipe(
      Effect.provideService(FetchHttpClient.Fetch, async () => Response.json("not a boolean")),
    ),
  );
  expect(Schema.isSchemaError(malformed)).toBe(true);
  expect(transformed).toBe(1);
  const unavailable = await Effect.runPromise(
    call.pipe(
      Effect.provideService(FetchHttpClient.Fetch, async () => {
        throw new Error("offline");
      }),
    ),
  );
  expect(unavailable).toMatchObject({ _tag: "HttpClientError" });
});

it("propagates interruption to the native fetch signal", async () => {
  const started = Effect.runSync(Deferred.make<void>());
  let aborted = false;
  const call = Effect.gen(function* () {
    const client = yield* Http.client(actions, { baseUrl: "http://localhost" });
    return yield* client.ping();
  }).pipe(
    Effect.provide(FetchHttpClient.layer),
    Effect.provideService(
      FetchHttpClient.Fetch,
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          if (!signal) throw new Error("Missing native abort signal");
          signal.addEventListener(
            "abort",
            () => {
              aborted = true;
              reject(new Error("aborted"));
            },
            { once: true },
          );
          Effect.runSync(Deferred.succeed(started, undefined));
        }),
    ),
  );
  const fiber = Effect.runFork(call);
  try {
    await Effect.runPromise(Deferred.await(started));
  } finally {
    await Effect.runPromise(Fiber.interrupt(fiber));
  }
  expect(aborted).toBe(true);
});

it("rejects a flattened then method rather than hanging Promise resolution", async () => {
  const group = ActionGroup.make(
    Action.make("then", {
      description: "Valid action, but unsafe as a direct client method",
      success: Schema.String,
    }),
  );
  await expect(
    Effect.runPromise(Http.client(group).pipe(Effect.provide(FetchHttpClient.layer))),
  ).rejects.toThrow('Action "then" requires the native grouped HttpApiClient');
  expect(Http.api(group).groups.actions.endpoints.then).toBeDefined();
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
    Action.make("nullable", {
      description: "Nullable object",
      input: Schema.NullOr(optional),
      success: Schema.Boolean,
      mcp: false,
    }),
    Action.make("undefinedValue", {
      description: "Undefined is real decoded data",
      input: undefinedFromString,
      success: Schema.Boolean,
      mcp: false,
    }),
  );
  const bodies: unknown[] = [];
  await Effect.gen(function* () {
    const client = yield* ActionHttp.client(group, {
      apiPath: "/api/actions",
      baseUrl: "http://localhost",
    });
    yield* client.nullable(null);
    yield* client.nullable(undefined);
    yield* client.undefinedValue(undefined);
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
