import { expect, it, onTestFinished } from "vite-plus/test";
import { Effect, Schema, SchemaTransformation } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http";
import { HttpApiClient, OpenApi } from "effect/unstable/httpapi";
import * as Action from "../src/Action.js";
import * as ActionHttp from "../src/ActionHttp.js";
import * as ActionHttpClient from "../src/ActionHttpClient.js";
import * as Testing from "../src/Testing.js";

class Invalid extends Schema.TaggedError<Invalid>()(
  "Invalid",
  { message: Schema.String },
  { httpApiStatus: 500 },
) {}

const Double = Action.make("double", {
  description: "Transform in both directions",
  access: "write",
  input: { value: Schema.FiniteFromString },
  success: Schema.FiniteFromString,
});

const Ping = Action.make("ping", {
  description: "No input",
  access: "write",
  success: Schema.Boolean,
});

const Optional = Action.make("optional", {
  description: "Optional input",
  access: "write",
  input: { value: Schema.optional(Schema.Number) },
  success: Schema.Number,
});

const Http = ActionHttp.make([Double, Ping, Optional], {
  prefix: "/rpc",
  errors: [Invalid],
  schemaError: {
    invalid: () => new Invalid({ message: "Invalid input" }),
    internal: () => new Invalid({ message: "Invalid output" }),
  },
});

const app = Action.implement([Double, Ping, Optional], {
  double: ({ value }) => Effect.succeed(value === 0 ? Infinity : value * 2),
  ping: () => Effect.succeed(true),
  optional: ({ value }) => Effect.succeed(value ?? 7),
});

it("keeps the client, routes and document on one configuration", async () => {
  const web = Testing.serve(ActionHttp.layer(Http, app));

  const sent: Array<{ url: string; body: unknown; token: string | null }> = [];
  onTestFinished(() => web.dispose());
  const document = OpenApi.fromApi(Http.api);
  expect(document.paths?.["/rpc/double"]?.post?.responses).toHaveProperty("500");
  await Effect.gen(function* () {
    const connection = {
      baseUrl: "http://localhost",
      transformClient: (client: HttpClient.HttpClient) =>
        client.pipe(
          HttpClient.mapRequest(HttpClientRequest.setHeader("authorization", "Bearer test")),
        ),
    };

    const client = yield* ActionHttpClient.make(Http, connection);

    expect(Object.keys(client).sort()).toEqual(["double", "optional", "ping"]);
    expect(yield* client.double({ value: 21 })).toBe(42);
    expect(yield* client.ping()).toBe(true);
    // `{}` is a valid input, so the argument may be omitted, and omitting it sends `{}`.
    expect(yield* client.optional()).toBe(7);
    expect(yield* client.optional({})).toBe(7);
    expect(yield* client.optional({ value: 3 })).toBe(3);
    expect(yield* Effect.flip(client.double({ value: 0 }))).toEqual(
      new Invalid({ message: "Invalid output" }),
    );

    // The native client stays available on the same API, with its response modes.
    const native = yield* HttpApiClient.make(Http.api, connection);

    const [value, response] = yield* native.ping({
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
    url: "http://localhost/rpc/double",
    body: { value: "21" },
    token: "Bearer test",
  });
  expect(sent.slice(1, 3).map((request) => request.body)).toEqual([{}, {}]);
});

it("sends a no-input call as {}, and any given input as given, through every Effect client", async () => {
  const undefinedFromString = Schema.Literal("absent").pipe(
    Schema.decodeTo(
      Schema.Undefined,
      SchemaTransformation.transform({
        decode: () => undefined,
        encode: () => "absent" as const,
      }),
    ),
  );

  const Nullable = Action.make("nullable", {
    description: "Nullable object",
    access: "write",
    input: Schema.NullOr(Schema.Struct({ value: Schema.optional(Schema.Number) })),
    success: Schema.String,
  });

  const UndefinedValue = Action.make("undefinedValue", {
    description: "Undefined is real decoded data",
    access: "write",
    input: undefinedFromString,
    success: Schema.String,
  });

  // Typed like an action without `input`, so it is called the same way.
  const EmptyRecord = Action.make("emptyRecord", {
    description: "A hand-written empty-record input",
    access: "read",
    input: Schema.Record(Schema.String, Schema.Never),
    success: Schema.Boolean,
  });

  const Inputs = ActionHttp.make([Ping, Nullable, UndefinedValue, EmptyRecord]);

  const bodies: Array<unknown> = [];

  const web = Testing.serve(
    ActionHttp.layer(
      Inputs,
      Action.implement([Ping, Nullable, UndefinedValue, EmptyRecord], {
        ping: () => Effect.succeed(true),
        nullable: (input) => Effect.succeed(input === null ? "null" : "object"),
        undefinedValue: (input) => Effect.succeed(String(input)),
        emptyRecord: () => Effect.succeed(true),
      }),
    ),
  );

  onTestFinished(() => web.dispose());

  const handler = async (request: Request) => {
    bodies.push(await request.clone().json());

    return web.handler(request);
  };

  const calls = (client: ActionHttpClient.Client<typeof Inputs>) =>
    Effect.all([
      client.ping(),
      client.nullable(null),
      client.nullable({}),
      client.undefinedValue(undefined),
      client.emptyRecord(),
    ]);

  const viaMake = await Effect.flatMap(
    ActionHttpClient.make(Inputs, { baseUrl: "http://localhost" }),
    calls,
  ).pipe(
    Effect.provide(FetchHttpClient.layer),
    Effect.provideService(FetchHttpClient.Fetch, (input, init) =>
      handler(new Request(input, init)),
    ),
    Effect.runPromise,
  );

  const viaTesting = await Effect.flatMap(Testing.httpClient(Inputs, handler), calls).pipe(
    Effect.runPromise,
  );

  expect(viaMake).toEqual([true, "null", "object", "undefined", true]);
  expect(viaTesting).toEqual(viaMake);
  expect(bodies).toEqual([{}, null, {}, "absent", {}, {}, null, {}, "absent", {}]);
});
