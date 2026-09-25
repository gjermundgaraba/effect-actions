import { expect, it, onTestFinished, vi } from "vite-plus/test";
import { Effect, Schema, SchemaGetter as Getter } from "effect";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientError,
  HttpClientRequest,
} from "effect/unstable/http";
import { HttpApiClient } from "effect/unstable/httpapi";
import * as Action from "../src/Action.js";
import * as ActionHttp from "../src/ActionHttp.js";
import * as ActionHttpClient from "../src/ActionHttpClient.js";
import { httpClient, serve } from "../src/Testing.js";

class NotFound extends Schema.TaggedError<NotFound>()(
  "NotFound",
  { id: Schema.String },
  { httpApiStatus: 404 },
) {}

class InvalidInput extends Schema.TaggedError<InvalidInput>()(
  "InvalidInput",
  { message: Schema.String },
  { httpApiStatus: 400 },
) {}

class Unencodable extends Schema.TaggedError<Unencodable>()(
  "Unencodable",
  {},
  { httpApiStatus: 500 },
) {}

class Forbidden extends Schema.TaggedError<Forbidden>()("Forbidden", {}, { httpApiStatus: 403 }) {}

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

const Http = ActionHttp.make([Get, Count, Remove], {
  errors: [Forbidden, InvalidInput, Unencodable],
  schemaError: {
    invalid: () => new InvalidInput({ message: "Bad input" }),
    internal: () => new Unencodable(),
  },
});

const at = new Date("2026-09-23T00:00:00.000Z");

const apps = Action.implement([Get, Count, Remove], {
  get: ({ id }) =>
    id === "missing"
      ? Effect.fail(new NotFound({ id }))
      : Effect.succeed({
          id,
          at: Schema.decodeSync(Schema.DateTimeUtcFromString)(at.toISOString()),
        }),
  count: () => Effect.succeed(Infinity),
  remove: () => Effect.succeed(null),
});

const serveNotes = () => {
  const requests: Array<Request> = [];

  const web = serve(
    ActionHttp.layer(Http, apps, {
      before: (action) => (action.access === "write" ? Effect.fail(new Forbidden()) : Effect.void),
    }),
  );

  onTestFinished(() => web.dispose());

  const fetch: typeof globalThis.fetch = (input, init) => {
    const request = new Request(input, init);
    requests.push(request.clone());

    return web.handler(request);
  };

  return { fetch, requests };
};

it("resolves with each action's decoded success, sending its encoded input", async () => {
  const { fetch, requests } = serveNotes();
  const client = ActionHttpClient.promise(Http, { baseUrl: "https://notes.example", fetch });

  const note = await client.get({ id: "a" });

  expect(note.id).toBe("a");
  expect(note.at.epochMilliseconds).toBe(at.getTime());
  expect(requests[0]?.url).toBe("https://notes.example/api/get");
  expect(await requests[0]?.json()).toEqual({ id: "a" });
  expect(requests[0]?.headers.has("authorization")).toBe(false);
});

it("calls an action without input with no argument", async () => {
  const { fetch, requests } = serveNotes();
  const client = ActionHttpClient.promise(Http, { baseUrl: "https://notes.example", fetch });

  // `Infinity` is not JSON, so the count is refused by the binding's policy instead.
  await expect(client.count()).rejects.toEqual(new Unencodable());
  expect(await requests[0]?.json()).toEqual({});

  // An action declared without `input` takes no argument, not even `undefined`.
  const checkTypes = () => {
    // @ts-expect-error `count` takes no argument.
    void client.count(undefined);
  };

  void checkTypes;
});

it("sends null, and undefined its input schema accepts, as the input rather than the empty one", async () => {
  const Echo = Action.make("echo", {
    description: "Echo a nullable input",
    access: "read",
    input: Schema.NullOr(Schema.Struct({ a: Schema.optional(Schema.Number) })),
    success: Schema.String,
  });

  // `"absent"` on the wire, `undefined` in the handler.
  const Absent = Action.make("absent", {
    description: "Echo an input whose decoded value may be undefined",
    access: "read",
    input: Schema.Literal("absent").pipe(
      Schema.decodeTo(Schema.Undefined, {
        decode: Getter.transform(() => undefined),
        encode: Getter.transform(() => "absent" as const),
      }),
    ),
    success: Schema.String,
  });

  const Echoes = ActionHttp.make([Echo, Absent]);

  const web = serve(
    ActionHttp.layer(
      Echoes,
      Action.implement([Echo, Absent], {
        echo: (input) => Effect.succeed(input === null ? "null" : "object"),
        absent: (input) => Effect.succeed(String(input)),
      }),
    ),
  );

  onTestFinished(() => web.dispose());

  const requests: Array<Request> = [];

  const client = ActionHttpClient.promise(Echoes, {
    baseUrl: "https://notes.example",
    fetch: (input, init) => {
      const request = new Request(input, init);
      requests.push(request.clone());

      return web.handler(request);
    },
  });

  expect(await client.echo(null)).toBe("null");
  expect(await requests[0]?.json()).toBeNull();
  expect(await client.echo({})).toBe("object");
  expect(await client.absent(undefined)).toBe("undefined");
  expect(await requests[2]?.json()).toBe("absent");
});

it("rejects with the declared error values: the action's, the policy's and the surface's", async () => {
  const { fetch } = serveNotes();
  const client = ActionHttpClient.promise(Http, { baseUrl: "https://notes.example", fetch });

  const missing = client.get({ id: "missing" });
  await expect(missing).rejects.toBeInstanceOf(NotFound);
  await expect(missing).rejects.toEqual(new NotFound({ id: "missing" }));
  await expect(client.remove()).rejects.toEqual(new Forbidden());

  const raw = ActionHttpClient.promise(Http, {
    baseUrl: "https://notes.example",
    fetch: (input, init) => fetch(input, { ...init, body: JSON.stringify({ id: 1 }) }),
  });

  await expect(raw.get({ id: "a" })).rejects.toEqual(new InvalidInput({ message: "Bad input" }));
});

it("passes the native client options through, such as a bearer token on every call", async () => {
  const { fetch, requests } = serveNotes();

  const client = ActionHttpClient.promise(Http, {
    baseUrl: "https://notes.example",
    transformClient: HttpClient.mapRequest(HttpClientRequest.bearerToken("t0k")),
    fetch,
  });

  await client.get({ id: "a" });
  await expect(client.remove()).rejects.toEqual(new Forbidden());
  expect(requests.map((request) => request.headers.get("authorization"))).toEqual([
    "Bearer t0k",
    "Bearer t0k",
  ]);
});

it("rejects with Effect's own errors when the contract cannot account for the answer", async () => {
  const answering = (response: Response) =>
    ActionHttpClient.promise(Http, {
      baseUrl: "https://notes.example",
      fetch: async () => response,
    });

  const undeclared = await answering(new Response("Bad gateway", { status: 502 }))
    .get({ id: "a" })
    .catch((error: Error) => error);

  expect(HttpClientError.isHttpClientError(undeclared)).toBe(true);
  expect(HttpClientError.isHttpClientError(undeclared) && undeclared.response?.status).toBe(502);

  const unreachable = await ActionHttpClient.promise(Http, {
    baseUrl: "https://notes.example",
    fetch: () => Promise.reject(new TypeError("fetch failed")),
  })
    .get({ id: "a" })
    .catch((error: Error) => error);

  expect(HttpClientError.isHttpClientError(unreachable)).toBe(true);
  expect(HttpClientError.isHttpClientError(unreachable) && unreachable.response).toBeUndefined();

  const malformed = await answering(Response.json({ id: 1 }))
    .get({ id: "a" })
    .catch((error: Error) => error);

  expect(Schema.isSchemaError(malformed)).toBe(true);
});

it("resolves relative routes against the page and looks the global fetch up on each call", async () => {
  const { fetch, requests } = serveNotes();
  const client = ActionHttpClient.promise(Http);
  // Stubbed after the client was made: a page's own origin, and the global transport.
  vi.stubGlobal("location", { origin: "https://page.example", pathname: "/notes" });
  vi.stubGlobal("fetch", fetch);
  onTestFinished(() => {
    vi.unstubAllGlobals();
  });

  expect((await client.get({ id: "a" })).id).toBe("a");
  expect(requests[0]?.url).toBe("https://page.example/api/get");
});

it("has one method per action", () => {
  const client = ActionHttpClient.promise(Http, { baseUrl: "https://notes.example" });

  expect(Object.keys(client)).toEqual(["get", "count", "remove"]);
});

/** The Effect client over `fetch`, as a program's own `HttpClient` would carry it. */
const effectClient =
  (fetch: typeof globalThis.fetch) =>
  <A, E>(use: (client: ActionHttpClient.Client<typeof Http>) => Effect.Effect<A, E>) =>
    Effect.flatMap(ActionHttpClient.make(Http, { baseUrl: "https://notes.example" }), use).pipe(
      Effect.provide(FetchHttpClient.layer),
      Effect.provideService(FetchHttpClient.Fetch, fetch),
      Effect.runPromise,
    );

it("gives the Effect client each action's success and every declared failure", async () => {
  const { fetch, requests } = serveNotes();

  const results = await effectClient(fetch)((client) =>
    Effect.all({
      note: client.get({ id: "a" }),
      missing: Effect.flip(client.get({ id: "missing" })),
      // No argument: the action has no input.
      unencodable: Effect.flip(client.count()),
      forbidden: Effect.flip(client.remove()),
    }),
  );

  expect(results.note.id).toBe("a");
  expect(results.missing).toEqual(new NotFound({ id: "missing" }));
  expect(results.unencodable).toEqual(new Unencodable());
  expect(results.forbidden).toEqual(new Forbidden());
  expect(await requests[0]?.json()).toEqual({ id: "a" });
  expect(await requests[2]?.json()).toEqual({});

  const invalid = await effectClient((input, init) =>
    fetch(input, { ...init, body: JSON.stringify({ id: 1 }) }),
  )((client) => Effect.flip(client.get({ id: "a" })));

  expect(invalid).toEqual(new InvalidInput({ message: "Bad input" }));
});

it("fails the Effect client with Effect's own error when the server is unreachable", async () => {
  const unreachable = await effectClient(() => Promise.reject(new TypeError("fetch failed")))(
    (client) => Effect.flip(client.get({ id: "a" })),
  );

  expect(HttpClientError.isHttpClientError(unreachable)).toBe(true);
  expect(HttpClientError.isHttpClientError(unreachable) && unreachable.response).toBeUndefined();
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
