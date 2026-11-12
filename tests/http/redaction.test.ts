import { describe, expect, it } from "@effect/vitest";
import { Context, Effect, Layer, Redacted, Schema, Tracer } from "effect";
import { HttpClient, HttpClientRequest, HttpMiddleware } from "effect/http";
import { HttpApiSecurity } from "effect/http-api";

import * as Authentication from "../../src/authentication/Authentication.js";
import * as Action from "../../src/contract/Action.js";
import * as ActionHttp from "../../src/http/ActionHttp.js";
import { post } from "../support/requests.js";
import { httpClient, serveWithContext } from "../support/serve.js";
import { recordSpans } from "../support/tracing.js";

class Identity extends Context.Service<Identity, { readonly id: string }>()(
  "test/Identity"
) {}

const Identify = Action.make("identify", {
  description: "Name the authenticated caller",
  readOnly: true,
  caller: Identity,
  success: Schema.String,
});

const Ping = Action.make("ping", {
  description: "Answer anyone",
  readOnly: true,
  caller: Action.Anyone,
  success: Schema.String,
});

const app = Action.implement(
  [Identify, Ping],
  {
    identify: () => Effect.map(Identity, ({ id }) => id),
    ping: () => Effect.succeed("pong"),
  },
  { authorize: Action.allowAll }
);

const key = "k-7f3a9c";

const QueryKey = Authentication.make("test.QueryKey", Identity, {
  security: HttpApiSecurity.apiKey({ in: "query", key: "api_key" }),
});

const HeaderKey = Authentication.make("test.HeaderKey", Identity, {
  security: HttpApiSecurity.apiKey({ in: "header", key: "x-tenant-key" }),
});

const verifier = (seen: string[]) => (credential: Redacted.Redacted) => {
  seen.push(Redacted.value(credential));

  return Redacted.value(credential) === key
    ? Effect.succeed({ id: "alice" })
    : Effect.fail(new Action.Unauthenticated());
};

const attributesOf = (spans: readonly Tracer.Span[]) =>
  spans.flatMap((span) => [...span.attributes.entries()]);

const QueryHttp = ActionHttp.make([Identify, Ping], {
  authentication: QueryKey,
});

const serveKeyed = (seen: string[], served: "identify" | "ping") =>
  serveWithContext(
    ActionHttp.layer(QueryHttp, app, {
      actions: [served === "identify" ? Identify : Ping],
    }).pipe(Layer.provide(Authentication.layer(QueryKey, verifier(seen))))
  );

describe("an API key in the query", () => {
  it.each(["identify", "ping"] as const)(
    "is redacted from the server span of %s, served alone",
    async (name) => {
      const seen: string[] = [];
      const web = serveKeyed(seen, name);
      const { spans, tracer } = recordSpans();

      const response = await web.handler(
        post(`/api/${name}?api_key=${key}&page=2`),
        Context.make(Tracer.Tracer, tracer)
      );

      expect(response.status).toBe(200);
      expect(seen).toStrictEqual(name === "identify" ? [key] : []);
      expect(attributesOf(spans)).toContainEqual([
        "url.query",
        "api_key=REDACTED&page=2",
      ]);
      expect(JSON.stringify(attributesOf(spans))).not.toContain(key);
    }
  );

  it("is redacted from the client span", async () => {
    const seen: string[] = [];
    const web = serveKeyed(seen, "identify");
    const { spans, tracer } = recordSpans();

    const answer = await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* httpClient(QueryHttp, web.handler, {
          baseUrl: "http://localhost",
          transformClient: HttpClient.mapRequest(
            HttpClientRequest.setUrlParam("api_key", key)
          ),
        });

        return yield* client.identify();
      }).pipe(Effect.provideService(Tracer.Tracer, tracer))
    );

    expect(answer).toBe("alice");
    expect(seen).toStrictEqual([key]);
    expect(attributesOf(spans)).toContainEqual([
      "url.query",
      "api_key=REDACTED",
    ]);
    expect(JSON.stringify(attributesOf(spans))).not.toContain(key);
  });
});

describe("an API key in a header", () => {
  it("is redacted from a server span recording headers", async () => {
    const seen: string[] = [];

    const web = serveWithContext(
      ActionHttp.layer(
        ActionHttp.make([Identify], { authentication: HeaderKey }),
        app
      ).pipe(Layer.provide(Authentication.layer(HeaderKey, verifier(seen))))
    );

    const { spans, tracer } = recordSpans();
    const request = post("/api/identify");
    request.headers.set("x-tenant-key", key);

    const response = await web.handler(
      request,
      Context.make(Tracer.Tracer, tracer).pipe(
        Context.add(HttpMiddleware.TracerHeaderFilter, () => true)
      )
    );

    expect(response.status).toBe(200);
    expect(seen).toStrictEqual([key]);
    expect(attributesOf(spans)).toContainEqual([
      "http.request.header.x-tenant-key",
      "<redacted>",
    ]);
    expect(JSON.stringify(attributesOf(spans))).not.toContain(key);
  });
});
