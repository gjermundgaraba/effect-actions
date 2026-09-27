import { expect, it, onTestFinished } from "vite-plus/test";
import { Effect, Schema } from "effect";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientError,
  HttpClientRequest,
} from "effect/unstable/http";
import { HttpApiClient } from "effect/unstable/httpapi";
import * as Action from "../src/Action.js";
import * as ActionHttp from "../src/ActionHttp.js";
import { httpClient, serve } from "./serve.js";

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

const serveNotes = () => {
  const requests: Array<Request> = [];

  const web = serve(ActionHttp.layer(Http, apps));

  onTestFinished(() => web.dispose());

  const fetch: typeof globalThis.fetch = (input, init) => {
    const request = new Request(input, init);
    requests.push(request.clone());

    return web.handler(request);
  };

  return { fetch, requests };
};

/** The Effect client over `fetch`, as a program's own `HttpClient` would carry it. */
const effectClient =
  (fetch: typeof globalThis.fetch, options?: Parameters<typeof ActionHttp.client>[1]) =>
  <A, E>(use: (client: ActionHttp.Client<typeof Http>) => Effect.Effect<A, E>) =>
    Effect.flatMap(
      ActionHttp.client(Http, { baseUrl: "https://notes.example", ...options }),
      use,
    ).pipe(
      Effect.provide(FetchHttpClient.layer),
      Effect.provideService(FetchHttpClient.Fetch, fetch),
      Effect.runPromise,
    );

it("gives the Effect client each action's success and every declared failure", async () => {
  const { fetch, requests } = serveNotes();

  const results = await effectClient(fetch)((client) =>
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
    HttpClientError.isHttpClientError(results.unencodable) && results.unencodable.response?.status,
  ).toBe(500);
  expect(results.forbidden).toEqual(new Action.Forbidden());
  expect(requests[0]?.url).toBe("https://notes.example/api/get");
  expect(await requests[0]?.json()).toEqual({ id: "a" });
  expect(requests[0]?.headers.has("authorization")).toBe(false);
  expect(await requests[2]?.json()).toEqual({});

  const invalid = await effectClient((input, init) =>
    fetch(input, { ...init, body: JSON.stringify({ id: 1 }) }),
  )((client) => Effect.flip(client.get({ id: "a" })));

  expect(invalid).toBeInstanceOf(Action.InvalidInput);

  // An action declared without `input` takes no argument, not even `undefined`.
  const checkTypes = (client: ActionHttp.Client<typeof Http>) => {
    // @ts-expect-error `count` takes no argument.
    void client.count(undefined);
  };

  void checkTypes;
});

it("passes the native client options through, such as a bearer token on every call", async () => {
  const { fetch, requests } = serveNotes();

  const forbidden = await effectClient(fetch, {
    transformClient: HttpClient.mapRequest(HttpClientRequest.bearerToken("t0k")),
  })((client) => Effect.andThen(client.get({ id: "a" }), Effect.flip(client.remove())));

  expect(forbidden).toEqual(new Action.Forbidden());
  expect(requests.map((request) => request.headers.get("authorization"))).toEqual([
    "Bearer t0k",
    "Bearer t0k",
  ]);
});

it("fails with Effect's own errors when the contract cannot account for the answer", async () => {
  const answering = (response: Response) =>
    effectClient(async () => response)((client) => Effect.flip(client.get({ id: "a" })));

  const undeclared = await answering(new Response("Bad gateway", { status: 502 }));

  expect(HttpClientError.isHttpClientError(undeclared)).toBe(true);
  expect(HttpClientError.isHttpClientError(undeclared) && undeclared.response?.status).toBe(502);

  const unreachable = await effectClient(() => Promise.reject(new TypeError("fetch failed")))(
    (client) => Effect.flip(client.get({ id: "a" })),
  );

  expect(HttpClientError.isHttpClientError(unreachable)).toBe(true);
  expect(HttpClientError.isHttpClientError(unreachable) && unreachable.response).toBeUndefined();

  const malformed = await answering(Response.json({ id: 1 }));

  expect(Schema.isSchemaError(malformed)).toBe(true);
});

it("fails an unserved action's call by whether the action declares its 404", async () => {
  const web = serve(ActionHttp.layer(Http, []));

  onTestFinished(() => web.dispose());

  const reasonOf = <A, E>(call: Effect.Effect<A, E>) =>
    Effect.map(Effect.flip(call), (error) =>
      HttpClientError.isHttpClientError(error) ? error.reason._tag : "declared",
    );

  const reasons = await Effect.runPromise(
    Effect.flatMap(httpClient(Http, web), (client) =>
      Effect.all([reasonOf(client.get({ id: "a" })), reasonOf(client.count())]),
    ),
  );

  // `get` declares a 404, whose body the empty answer is not; `count` declares none.
  expect(reasons).toEqual(["StatusCodeError", "DecodeError"]);
});

it("keeps the native HttpApi usable with Effect's own client", async () => {
  const flat = serveNotes();

  const note = await Effect.gen(function* () {
    const client = yield* HttpApiClient.make(Http.api, { baseUrl: "https://notes.example" });

    // A flat binding is one top-level group: its methods are not nested.
    return yield* client.get({ payload: { id: "a" } });
  }).pipe(
    Effect.provide(FetchHttpClient.layer),
    Effect.provideService(FetchHttpClient.Fetch, flat.fetch),
    Effect.runPromise,
  );

  expect(note.id).toBe("a");
});
