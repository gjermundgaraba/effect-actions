import { expect, it, onTestFinished, vi } from "vite-plus/test";
import { Effect, Layer, Schema } from "effect";
import { HttpClientError, HttpRouter, HttpServer } from "effect/unstable/http";
import * as Action from "../src/Action.js";
import * as ActionGroup from "../src/ActionGroup.js";
import * as ActionHttp from "../src/ActionHttp.js";
import * as ActionHttpClient from "../src/ActionHttpClient.js";

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

const Notes = ActionGroup.make(
  {
    name: "notes",
    schemaError: {
      invalid: { schema: InvalidInput, make: () => new InvalidInput({ message: "Bad input" }) },
      internal: { schema: Unencodable, make: () => new Unencodable() },
    },
  },
  Action.make("get", {
    description: "Read a note",
    access: "read",
    input: Schema.Struct({ id: Schema.String }),
    success: Schema.Struct({ id: Schema.String, at: Schema.DateTimeUtcFromString }),
    errors: [NotFound],
  }),
  Action.make("count", { description: "Count notes", access: "read", success: Schema.Finite }),
  Action.make("remove", {
    description: "Remove every note",
    access: "write",
    success: Schema.Null,
  }),
  Action.make("summarize", {
    description: "MCP only",
    access: "read",
    success: Schema.String,
    http: false,
  }),
);

const Tools = ActionGroup.make(
  { name: "tools" },
  Action.make("reindex", {
    description: "MCP only",
    access: "write",
    success: Schema.Null,
    http: false,
  }),
);

const Http = ActionHttp.make({ apiPath: "/api", errors: [Forbidden] }, Notes, Tools);

const at = new Date("2026-09-23T00:00:00.000Z");

const app = Notes.implement({
  get: ({ id }) =>
    id === "missing"
      ? Effect.fail(new NotFound({ id }))
      : Effect.succeed({
          id,
          at: Schema.decodeSync(Schema.DateTimeUtcFromString)(at.toISOString()),
        }),
  count: () => Effect.succeed(Infinity),
  remove: () => Effect.succeed(null),
  summarize: () => Effect.succeed("summary"),
});

const serve = () => {
  const requests: Array<Request> = [];

  const web = HttpRouter.toWebHandler(
    Http.layer([app], {
      before: (action) => (action.access === "write" ? Effect.fail(new Forbidden()) : Effect.void),
    }).pipe(Layer.provide(HttpServer.layerServices)),
    { disableLogger: true },
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
  const { fetch, requests } = serve();
  const client = ActionHttpClient.promise(Http, { baseUrl: "https://notes.example", fetch });

  const note = await client.notes.get({ id: "a" });

  expect(note.id).toBe("a");
  expect(note.at.epochMilliseconds).toBe(at.getTime());
  expect(requests[0]?.url).toBe("https://notes.example/api/notes/get");
  expect(await requests[0]?.json()).toEqual({ id: "a" });
  expect(requests[0]?.headers.has("authorization")).toBe(false);
});

it("calls an action without input with no argument", async () => {
  const { fetch, requests } = serve();
  const client = ActionHttpClient.promise(Http, { baseUrl: "https://notes.example", fetch });

  // `Infinity` is not JSON, so the count is refused by the group's policy instead.
  await expect(client.notes.count()).rejects.toEqual(new Unencodable());
  expect(await requests[0]?.json()).toEqual({});

  // A caller forwarding an optional input may pass `undefined` explicitly.
  const forwarded: Parameters<typeof client.notes.count>[0] = undefined;
  await expect(client.notes.count(forwarded)).rejects.toEqual(new Unencodable());
  expect(await requests[1]?.json()).toEqual({});
});

it("rejects with the declared error values: the action's, the policy's and the surface's", async () => {
  const { fetch } = serve();
  const client = ActionHttpClient.promise(Http, { baseUrl: "https://notes.example", fetch });

  const missing = client.notes.get({ id: "missing" });
  await expect(missing).rejects.toBeInstanceOf(NotFound);
  await expect(missing).rejects.toEqual(new NotFound({ id: "missing" }));
  await expect(client.notes.remove()).rejects.toEqual(new Forbidden());

  const raw = ActionHttpClient.promise(Http, {
    baseUrl: "https://notes.example",
    fetch: (input, init) => fetch(input, { ...init, body: JSON.stringify({ id: 1 }) }),
  });

  await expect(raw.notes.get({ id: "a" })).rejects.toEqual(
    new InvalidInput({ message: "Bad input" }),
  );
});

it("sends the bearer token with every call", async () => {
  const { fetch, requests } = serve();

  const client = ActionHttpClient.promise(Http, {
    baseUrl: "https://notes.example",
    token: "t0k",
    fetch,
  });

  await client.notes.get({ id: "a" });
  await expect(client.notes.remove()).rejects.toEqual(new Forbidden());
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
    .notes.get({ id: "a" })
    .catch((error: Error) => error);

  expect(HttpClientError.isHttpClientError(undeclared)).toBe(true);
  expect(HttpClientError.isHttpClientError(undeclared) && undeclared.response?.status).toBe(502);

  const unreachable = await ActionHttpClient.promise(Http, {
    baseUrl: "https://notes.example",
    fetch: () => Promise.reject(new TypeError("fetch failed")),
  })
    .notes.get({ id: "a" })
    .catch((error: Error) => error);

  expect(HttpClientError.isHttpClientError(unreachable)).toBe(true);
  expect(HttpClientError.isHttpClientError(unreachable) && unreachable.response).toBeUndefined();

  const malformed = await answering(Response.json({ id: 1 }))
    .notes.get({ id: "a" })
    .catch((error: Error) => error);

  expect(Schema.isSchemaError(malformed)).toBe(true);
});

it("resolves relative routes against the page and looks the global fetch up on each call", async () => {
  const { fetch, requests } = serve();
  const client = ActionHttpClient.promise(Http);
  // Stubbed after the client was made: a page's own origin, and the global transport.
  vi.stubGlobal("location", { origin: "https://page.example", pathname: "/notes" });
  vi.stubGlobal("fetch", fetch);
  onTestFinished(() => {
    vi.unstubAllGlobals();
  });

  expect((await client.notes.get({ id: "a" })).id).toBe("a");
  expect(requests[0]?.url).toBe("https://page.example/api/notes/get");
});

it("has a method only for HTTP-served actions", () => {
  const client = ActionHttpClient.promise(Http, { baseUrl: "https://notes.example" });

  expect(Object.keys(client)).toEqual(["notes"]);
  expect(Object.keys(client.notes)).toEqual(["get", "count", "remove"]);
});
