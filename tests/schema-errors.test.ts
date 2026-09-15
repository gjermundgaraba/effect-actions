import { expect, it } from "vite-plus/test";
import { Context, Effect, Layer, Schema } from "effect";
import { FetchHttpClient, HttpRouter, HttpServer } from "effect/unstable/http";
import { HttpApiClient } from "effect/unstable/httpapi";
import { Action, ActionGroup, ActionHttp } from "../src/index.js";

class InvalidRequest extends Schema.TaggedError<InvalidRequest>()(
  "InvalidRequest",
  { error: Schema.String },
  { httpApiStatus: 400 },
) {}
class InvalidResponse extends Schema.TaggedError<InvalidResponse>()(
  "InvalidResponse",
  { error: Schema.String },
  { httpApiStatus: 500 },
) {}
class Rejected extends Schema.TaggedError<Rejected>()(
  "Rejected",
  { error: Schema.String },
  { httpApiStatus: 409 },
) {}
const options = {
  schemaError: {
    errors: [InvalidRequest, InvalidResponse],
    map: (failure) =>
      failure.kind === "Body" || failure.kind === "ResponseHeaders"
        ? new InvalidResponse({ error: "Invalid response" })
        : new InvalidRequest({ error: "Invalid request" }),
  },
} satisfies ActionHttp.Options<readonly [typeof InvalidRequest, typeof InvalidResponse]>;
const actions = ActionGroup.make(
  Action.make("echo", {
    description: "Echo",
    input: Schema.Struct({ value: Schema.Finite }),
    success: Schema.Finite,
    error: [Rejected],
  }),
);
const request = (value: unknown) =>
  new Request("http://localhost/api/actions/echo", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ value }),
  });

it("maps input and output failures and exposes the same error contract to clients", async () => {
  const app = actions.implement({
    echo: ({ value }) =>
      value < 0
        ? Effect.fail(new Rejected({ error: "Negative value" }))
        : Effect.succeed(value === 0 ? Infinity : value),
  });
  const web = HttpRouter.toWebHandler(
    ActionHttp.layer(app, options).pipe(Layer.provide(HttpServer.layerServices)),
    { disableLogger: true },
  );
  try {
    const malformed = await web.handler(request("secret input"));
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toEqual({ _tag: "InvalidRequest", error: "Invalid request" });
    const invalidJson = await web.handler(
      new Request("http://localhost/api/actions/echo", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{secret",
      }),
    );
    expect(invalidJson.status).toBe(400);
    expect(await invalidJson.json()).toEqual({ _tag: "InvalidRequest", error: "Invalid request" });
    const broken = await web.handler(request(0));
    expect(broken.status).toBe(500);
    expect(await broken.json()).toEqual({ _tag: "InvalidResponse", error: "Invalid response" });
    const rejected = await web.handler(request(-1));
    expect(rejected.status).toBe(409);
    expect(await rejected.json()).toEqual({ _tag: "Rejected", error: "Negative value" });
    const api = ActionHttp.api(actions, options);
    await Effect.gen(function* () {
      const client = yield* HttpApiClient.make(api, { baseUrl: "http://localhost" });
      expect(yield* client.actions.echo({ payload: { value: 12 } })).toBe(12);
      expect(yield* Effect.flip(client.actions.echo({ payload: { value: 0 } }))).toEqual(
        new InvalidResponse({ error: "Invalid response" }),
      );
      expect(yield* Effect.flip(client.actions.echo({ payload: { value: -1 } }))).toEqual(
        new Rejected({ error: "Negative value" }),
      );
    }).pipe(
      Effect.provide(FetchHttpClient.layer),
      Effect.provideService(FetchHttpClient.Fetch, (input, init) =>
        web.handler(new Request(input, init)),
      ),
      Effect.runPromise,
    );
    const document = ActionHttp.openapi(actions, options);
    expect(document.paths?.["/api/actions/echo"]?.post?.responses).toHaveProperty("400");
    expect(document.paths?.["/api/actions/echo"]?.post?.responses).toHaveProperty("500");
  } finally {
    await web.dispose();
  }
});

it("policy middleware does not turn startup services into request fallbacks", async () => {
  class Value extends Context.Service<Value, number>()("policy-test/Value") {}
  const app = actions.implement({ echo: () => Effect.map(Value, (value) => value) });
  const web = HttpRouter.toWebHandler(
    ActionHttp.layer(app, options).pipe(
      Layer.provide(Layer.succeed(Value, 42)),
      Layer.provide(HttpServer.layerServices),
    ),
    { disableLogger: true },
  );
  try {
    // @ts-expect-error Deliberately omit the required request service at runtime.
    const absent = await web.handler(request(1), Context.empty());
    expect(absent.status).toBe(500);
    expect(await absent.text()).toBe("");
    const present = await web.handler(request(1), Context.make(Value, 7));
    expect(await present.json()).toBe(7);
  } finally {
    await web.dispose();
  }
});

it("keeps separate policies isolated on projections of one implementation", async () => {
  const app = actions.implement({ echo: ({ value }) => Effect.succeed(value) });
  const web = HttpRouter.toWebHandler(
    Layer.merge(
      ActionHttp.layer(app, { prefix: "/a", openapiPath: false, ...options }),
      ActionHttp.layer(app, {
        prefix: "/b",
        openapiPath: false,
        schemaError: {
          errors: [InvalidResponse],
          map: () => new InvalidResponse({ error: "Second policy" }),
        },
      }),
    ).pipe(Layer.provide(HttpServer.layerServices)),
    { disableLogger: true },
  );
  try {
    for (const [path, status, message] of [
      ["a", 400, "Invalid request"],
      ["b", 500, "Second policy"],
    ] as const) {
      const response = await web.handler(
        new Request(`http://localhost/${path}/echo`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        }),
      );
      expect(response.status).toBe(status);
      expect(await response.json()).toMatchObject({ error: message });
    }
  } finally {
    await web.dispose();
  }
});
