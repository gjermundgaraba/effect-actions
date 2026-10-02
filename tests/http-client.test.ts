import { expect, it } from "@effect/vitest";
import { Effect, Schema, SchemaTransformation } from "effect";
import { HttpClient, HttpClientError, HttpClientRequest } from "effect/http";
import { OpenApi } from "effect/http-api";
import * as Action from "../src/Action.js";
import * as ActionHttp from "../src/ActionHttp.js";
import * as Testing from "../src/Testing.js";
import { type Handler, httpClient, serve } from "./serve.js";

class NotFound extends Schema.TaggedError<NotFound>()(
  "NotFound",
  { id: Schema.String },
  { httpApiStatus: 404 },
) {}

const Get = Action.make("get", {
  description: "Read a note",
  access: "read",
  input: { id: Schema.String },
  success: { id: Schema.String, at: Schema.DateTimeUtcFromString },
  errors: [NotFound],
});

const Count = Action.make("count", {
  description: "Count notes",
  access: "read",
  success: Schema.Finite,
});

const Remove = Action.make("remove", {
  description: "Remove every note",
  access: "write",
  success: Schema.Null,
});

const Http = ActionHttp.make([Get, Count, Remove]);

const at = new Date("2026-09-23T00:00:00.000Z");

const apps = Action.implement(
  [Get, Count, Remove],
  {
    get: ({ id }) =>
      id === "missing"
        ? Effect.fail(new NotFound({ id }))
        : Effect.succeed({
            id,
            at: Schema.decodeSync(Schema.DateTimeUtcFromString)(at.toISOString()),
          }),
    count: () => Effect.succeed(Infinity),
    remove: () => Effect.succeed(null),
  },
  (action) => (action.access === "write" ? Effect.fail(new Action.Forbidden()) : Effect.void),
);

/** The notes served in memory, recording each request they answer. */
const serveNotes = () => {
  const requests: Array<Request> = [];

  const web = serve(ActionHttp.layer(Http, apps));

  const handler: Handler = (request) => {
    requests.push(request.clone());

    return web.handler(request);
  };

  return { handler, requests };
};

it.effect("gives the Effect client each action's success and every declared failure", () =>
  Effect.gen(function* () {
    const { handler, requests } = serveNotes();

    const results = yield* Effect.flatMap(httpClient(Http, handler), (client) =>
      Effect.all({
        methods: Effect.succeed(Object.keys(client)),
        note: client.get({ id: "a" }),
        missing: Effect.flip(client.get({ id: "missing" })),
        // No argument: the action has no input.
        unencodable: Effect.flip(client.count()),
        forbidden: Effect.flip(client.remove()),
      }),
    );

    expect(results.methods).toEqual(["get", "count", "remove"]);
    expect(results.note.id).toBe("a");
    expect(results.note.at.epochMilliseconds).toBe(at.getTime());
    expect(results.missing).toEqual(new NotFound({ id: "missing" }));
    // `Infinity` is not JSON: the server's defect is an empty 500 the contract does not declare.
    expect(HttpClientError.isHttpClientError(results.unencodable)).toBe(true);
    expect(
      HttpClientError.isHttpClientError(results.unencodable) &&
        results.unencodable.response?.status,
    ).toBe(500);
    expect(results.forbidden).toEqual(new Action.Forbidden());
    expect(requests[0]?.url).toBe("http://localhost/api/get");
    expect(yield* Effect.promise(async () => requests[0]?.json())).toEqual({ id: "a" });
    expect(requests[0]?.headers.has("authorization")).toBe(false);
    expect(yield* Effect.promise(async () => requests[2]?.json())).toEqual({});

    const invalid = yield* Effect.flatMap(
      httpClient(Http, (request) =>
        handler(new Request(request, { method: "POST", body: JSON.stringify({ id: 1 }) })),
      ),
      (client) => Effect.flip(client.get({ id: "a" })),
    );

    expect(invalid).toBeInstanceOf(Action.InvalidInput);
  }),
);

it.effect("passes the native client options through, such as a bearer token on every call", () =>
  Effect.gen(function* () {
    const { handler, requests } = serveNotes();

    const forbidden = yield* Effect.flatMap(
      httpClient(Http, handler, {
        transformClient: HttpClient.mapRequest(HttpClientRequest.bearerToken("t0k")),
      }),
      (client) => Effect.andThen(client.get({ id: "a" }), Effect.flip(client.remove())),
    );

    expect(forbidden).toEqual(new Action.Forbidden());
    expect(requests.map((request) => request.headers.get("authorization"))).toEqual([
      "Bearer t0k",
      "Bearer t0k",
    ]);
  }),
);

it.effect("fails with Effect's own errors when the contract cannot account for the answer", () =>
  Effect.gen(function* () {
    const answering = (response: Response) =>
      Effect.flatMap(
        httpClient(Http, async () => response),
        (client) => Effect.flip(client.get({ id: "a" })),
      );

    const undeclared = yield* answering(new Response("Bad gateway", { status: 502 }));

    expect(HttpClientError.isHttpClientError(undeclared)).toBe(true);
    expect(HttpClientError.isHttpClientError(undeclared) && undeclared.response?.status).toBe(502);

    const unreachable = yield* Effect.flatMap(
      httpClient(Http, () => Promise.reject(new TypeError("fetch failed"))),
      (client) => Effect.flip(client.get({ id: "a" })),
    );

    expect(HttpClientError.isHttpClientError(unreachable)).toBe(true);
    expect(HttpClientError.isHttpClientError(unreachable) && unreachable.response).toBeUndefined();

    const malformed = yield* answering(Response.json({ id: 1 }));

    expect(Schema.isSchemaError(malformed)).toBe(true);
  }),
);

it.effect("fails an unserved action's call by whether the action declares its 404", () =>
  Effect.gen(function* () {
    const web = serve(ActionHttp.layer(Http, []));

    const reasonOf = <A, E>(call: Effect.Effect<A, E>) =>
      Effect.map(Effect.flip(call), (error) =>
        HttpClientError.isHttpClientError(error) ? error.reason._tag : "declared",
      );

    const reasons = yield* Effect.flatMap(httpClient(Http, web.handler), (client) =>
      Effect.all([reasonOf(client.get({ id: "a" })), reasonOf(client.count())]),
    );

    // `get` declares a 404, whose body the empty answer is not; `count` declares none.
    expect(reasons).toEqual(["StatusCodeError", "DecodeError"]);
  }),
);

it.effect(
  "sends a no-input call as {}, and any given input encoded as given, through the client",
  () =>
    Effect.gen(function* () {
      const Double = Action.make("double", {
        description: "Transform in both directions",
        access: "write",
        input: { value: Schema.FiniteFromString },
        success: Schema.FiniteFromString,
      });

      const Optional = Action.make("optional", {
        description: "Optional input",
        access: "write",
        input: { value: Schema.optional(Schema.Number) },
        success: Schema.Number,
      });

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

      const Inputs = ActionHttp.make([Double, Optional, Nullable, UndefinedValue, EmptyRecord]);

      const bodies: Array<unknown> = [];

      const web = serve(
        ActionHttp.layer(
          Inputs,
          Action.implement(
            [Double, Optional, Nullable, UndefinedValue, EmptyRecord],
            {
              double: ({ value }) => Effect.succeed(value * 2),
              optional: ({ value }) => Effect.succeed(value ?? 7),
              nullable: (input) => Effect.succeed(input === null ? "null" : "object"),
              undefinedValue: (input) => Effect.succeed(String(input)),
              emptyRecord: () => Effect.succeed(true),
            },
            Action.allowAll,
          ),
        ),
      );

      const handler = async (request: Request) => {
        bodies.push(await request.clone().json());

        return web.handler(request);
      };

      const calls = (client: ActionHttp.Client<typeof Inputs>) =>
        Effect.all([
          client.double({ value: 21 }),
          // `{}` is a valid input, so the argument may be omitted, and omitting it sends `{}`.
          client.optional(),
          client.optional({}),
          client.optional({ value: 3 }),
          client.nullable(null),
          client.nullable({}),
          client.undefinedValue(undefined),
          client.emptyRecord(),
        ]);

      const results = yield* Effect.flatMap(
        ActionHttp.client(Inputs, { baseUrl: "http://localhost" }),
        calls,
      ).pipe(Effect.provide(Testing.layer(handler)));

      expect(results).toEqual([42, 7, 7, 3, "null", "object", "undefined", true]);
      expect(bodies).toEqual([{ value: "21" }, {}, {}, { value: 3 }, null, {}, "absent", {}]);
    }),
);

it.effect("takes a left-out argument as the input {} decodes to, an input class's instance", () =>
  Effect.gen(function* () {
    class Filters extends Schema.Class<Filters>("Filters")({
      tag: Schema.optionalKey(Schema.String),
    }) {}

    const List = Action.make("list", {
      description: "List notes, all of them without a tag",
      access: "read",
      input: Filters,
      success: Schema.String,
    });

    const Lists = ActionHttp.make([List]);

    const bodies: Array<unknown> = [];

    const web = serve(
      ActionHttp.layer(
        Lists,
        Action.implement(
          List,
          (filters) => Effect.succeed(`${filters instanceof Filters}: ${filters.tag ?? "all"}`),
          Action.allowAll,
        ),
      ),
    );

    const handler = async (request: Request) => {
      bodies.push(await request.clone().json());

      return web.handler(request);
    };

    const results = yield* Effect.flatMap(
      ActionHttp.client(Lists, { baseUrl: "http://localhost" }),
      (client) => Effect.all([client.list(), client.list(new Filters({ tag: "x" }))]),
    ).pipe(Effect.provide(Testing.layer(handler)));

    // The client decodes `{}` before it encodes it, so the class sends `{}` as a struct would.
    expect(results).toEqual(["true: all", "true: x"]);
    expect(bodies).toEqual([{}, { tag: "x" }]);
  }),
);

it.effect("decodes two errors that share a status by their tag", () =>
  Effect.gen(function* () {
    class Rejected extends Schema.TaggedError<Rejected>()(
      "Rejected",
      { reason: Schema.String },
      { httpApiStatus: 403 },
    ) {}

    // Each action declares its own 403 beside the built-in `Forbidden` the hook raises.
    const Refuse = Action.make("refuse", {
      description: "Refused by the hook",
      access: "write",
      success: Schema.String,
      errors: [Rejected],
    });

    const Reject = Action.make("reject", {
      description: "Rejected by the handler",
      access: "read",
      success: Schema.String,
      errors: [Rejected],
    });

    const binding = ActionHttp.make([Refuse, Reject]);

    const web = serve(
      ActionHttp.layer(
        binding,
        Action.implement(
          [Refuse, Reject],
          {
            refuse: () => Effect.succeed("unreachable"),
            reject: () => Effect.fail(new Rejected({ reason: "closed" })),
          },
          (action) =>
            action.access === "read" ? Effect.void : Effect.fail(new Action.Forbidden()),
        ),
      ),
    );

    const refused = yield* Effect.flatMap(httpClient(binding, web.handler), (client) =>
      Effect.all([Effect.flip(client.refuse()), Effect.flip(client.reject())]),
    );

    // Both are reachable from each endpoint under 403; the tag selects the decoder.
    expect(refused).toEqual([new Action.Forbidden(), new Rejected({ reason: "closed" })]);
  }),
);

it.effect("declares a binding's errors on every endpoint, so middleware's answers decode", () =>
  Effect.gen(function* () {
    class RateLimited extends Schema.TaggedError<RateLimited>()(
      "RateLimited",
      { retryAfter: Schema.Finite },
      { httpApiStatus: 429 },
    ) {}

    // No status of its own: sent as 422, as an action's own would be.
    class Maintenance extends Schema.TaggedError<Maintenance>()("Maintenance", {}) {}

    const binding = ActionHttp.make([Get, Count], { errors: [RateLimited, Maintenance] });

    // What middleware around the routes answers with, as the binding declares it.
    const answering = (error: RateLimited | Maintenance, status: number) => () =>
      Promise.resolve(
        Response.json(Schema.encodeSync(Schema.Union([RateLimited, Maintenance]))(error), {
          status,
        }),
      );

    const failures = (handler: () => Promise<Response>) =>
      Effect.flatMap(httpClient(binding, handler), (client) =>
        Effect.all([Effect.flip(client.get({ id: "a" })), Effect.flip(client.count())]),
      );

    expect(yield* failures(answering(new RateLimited({ retryAfter: 3 }), 429))).toEqual([
      new RateLimited({ retryAfter: 3 }),
      new RateLimited({ retryAfter: 3 }),
    ]);

    expect(yield* failures(answering(new Maintenance(), 422))).toEqual([
      new Maintenance(),
      new Maintenance(),
    ]);

    for (const path of ["/api/get", "/api/count"]) {
      const responses = OpenApi.fromApi(binding.api).paths?.[path]?.post?.responses;
      expect(Object.keys(responses ?? {})).toEqual(expect.arrayContaining(["422", "429"]));
    }
  }),
);

it("refuses a binding error with a built-in error's tag", () => {
  class Forbidden extends Schema.TaggedError<Forbidden>()("Forbidden", {}) {}

  const binding = ActionHttp.make([Get], { errors: [Forbidden] });

  expect(() => ActionHttp.layer(binding, [])).toThrow(
    'ActionHttp binding: error _tag "Forbidden" is built in, and declared on every surface',
  );
});
