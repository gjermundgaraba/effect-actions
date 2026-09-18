import { expect, it, onTestFinished } from "vite-plus/test";
import { Deferred, Effect, Fiber, Layer, Predicate, Schema, SchemaTransformation } from "effect";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpRouter,
  HttpServer,
} from "effect/unstable/http";
import { OpenApi } from "effect/unstable/httpapi";
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
      errors: [Invalid],
      map: () => new Invalid({ message: "Invalid output" }),
    },
  },
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

const Http = ActionHttp.make({ apiPath: "/rpc" }, actions);

const app = actions.implement({
  double: ({ value }) => Effect.succeed(value === 0 ? Infinity : value * 2),
  ping: () => Effect.succeed(true),
  optional: ({ value }) => Effect.succeed(value ?? 7),
  hidden: () => Effect.succeed("hidden"),
});

it("keeps the client, routes and document on one configuration", async () => {
  const web = HttpRouter.toWebHandler(
    Http.layer(app).pipe(Layer.provide(HttpServer.layerServices)),
    {
      disableLogger: true,
    },
  );

  const sent: Array<{ url: string; body: unknown; token: string | null }> = [];
  onTestFinished(() => web.dispose());
  const document = OpenApi.fromApi(Http.api);
  expect(document.paths?.["/rpc/double"]?.post?.responses).toHaveProperty("500");
  expect(document.paths).not.toHaveProperty("/rpc/hidden");
  expect(Http.api.groups.numbers.endpoints.double).toBeDefined();
  await Effect.gen(function* () {
    const connection = {
      baseUrl: "http://localhost",
      transformClient: (client: HttpClient.HttpClient) =>
        client.pipe(
          HttpClient.mapRequest(HttpClientRequest.setHeader("authorization", "Bearer test")),
        ),
    };

    const client = yield* Http.client(connection);

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
});

it("retains native response validation, transport errors and response transforms", async () => {
  let transformed = 0;

  const call = Effect.gen(function* () {
    const client = yield* Http.client({
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

  expect(Predicate.isTagged("HttpClientError")(unavailable)).toBe(true);
});

it("propagates interruption to the native fetch signal", async () => {
  const started = Effect.runSync(Deferred.make<void>());
  let aborted = false;

  const call = Effect.gen(function* () {
    const client = yield* Http.client({ baseUrl: "http://localhost" });

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
    const client = yield* ActionHttp.make({ apiPath: "/api/actions" }, group).client({
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
