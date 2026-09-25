import { describe, expect, it, onTestFinished } from "vite-plus/test";
import { Context, Deferred, Effect, Layer, Option, Schema } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import * as Action from "../src/Action.js";
import * as ActionHttp from "../src/ActionHttp.js";
import * as ActionMcp from "../src/ActionMcp.js";
import * as Authentication from "../src/Authentication.js";
import { serve } from "../src/Testing.js";
import { rawToolCall } from "./requests.js";

class Identity extends Context.Service<Identity, { readonly id: string }>()("test/Identity") {}

class Tokens extends Context.Service<Tokens, { readonly prefix: string }>()("test/Tokens") {}

class Unauthorized extends Schema.TaggedError<Unauthorized>()(
  "Unauthorized",
  { message: Schema.String },
  { httpApiStatus: 401 },
) {}

class Forbidden extends Schema.TaggedError<Forbidden>()(
  "Forbidden",
  { message: Schema.String },
  { httpApiStatus: 403 },
) {}

const request = (token?: string) =>
  new Request("http://localhost/identity", {
    headers: token === undefined ? {} : { authorization: token },
  });

/** The host renders its own failures: any response, with the status and headers it chooses. */
const refuse = <E extends Unauthorized | Forbidden>(error: E, status: number) =>
  HttpServerResponse.schemaJson(Schema.Union([Unauthorized, Forbidden]))(error, {
    status,
    headers: { "www-authenticate": `Bearer error="${error._tag}"` },
  }).pipe(Effect.orDie, Effect.flip);

describe("Authentication.middleware", () => {
  it("sends the host's failure response, with its status and challenge headers", async () => {
    let calls = 0;

    const auth = Authentication.middleware(
      Identity,
      Effect.gen(function* () {
        const token = (yield* HttpServerRequest.HttpServerRequest).headers.authorization;

        if (token === undefined) {
          return yield* refuse(new Unauthorized({ message: "Missing token" }), 401);
        }

        if (token === "denied")
          return yield* refuse(new Forbidden({ message: "Denied token" }), 403);

        return { id: token };
      }),
    );

    const web = serve(
      HttpRouter.add(
        "GET",
        "/identity",
        Effect.gen(function* () {
          calls++;

          return HttpServerResponse.text((yield* Identity).id);
        }),
      ).pipe(Layer.provide(auth.layer)),
    );

    onTestFinished(() => web.dispose());

    for (const [token, status, tag] of [
      [undefined, 401, "Unauthorized"],
      ["denied", 403, "Forbidden"],
    ] as const) {
      const response = await web.handler(request(token));
      expect(response.status).toBe(status);
      expect(response.headers.get("www-authenticate")).toBe(`Bearer error="${tag}"`);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.json()).toMatchObject({ _tag: tag });
    }

    expect(calls).toBe(0);
    expect(await (await web.handler(request("alice"))).text()).toBe("alice");
    expect(await (await web.handler(request("bob"))).text()).toBe("bob");
    expect(calls).toBe(2);
  });

  it("answers a declared refusal as its JSON, with its status and the configured headers", async () => {
    const auth = Authentication.middleware(
      Identity,
      Effect.gen(function* () {
        const token = (yield* HttpServerRequest.HttpServerRequest).headers.authorization;

        if (token === undefined) return yield* new Unauthorized({ message: "Missing token" });

        if (token === "denied") return yield* new Forbidden({ message: "Denied token" });

        return { id: token };
      }),
      { errors: [Unauthorized, Forbidden], headers: { "www-authenticate": "Bearer" } },
    );

    const web = serve(
      HttpRouter.add(
        "GET",
        "/identity",
        Effect.map(Identity, ({ id }) => HttpServerResponse.text(id)),
      ).pipe(Layer.provide(auth.layer)),
    );

    onTestFinished(() => web.dispose());

    // The body is the error's own JSON encoding, the one a typed client decodes.
    for (const [token, status, body] of [
      [
        undefined,
        401,
        Schema.encodeSync(Unauthorized)(new Unauthorized({ message: "Missing token" })),
      ],
      ["denied", 403, Schema.encodeSync(Forbidden)(new Forbidden({ message: "Denied token" }))],
    ] as const) {
      const response = await web.handler(request(token));
      expect(response.status).toBe(status);
      expect(response.headers.get("content-type")).toContain("application/json");
      expect(response.headers.get("www-authenticate")).toBe("Bearer");
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.json()).toEqual(body);
    }

    expect(await (await web.handler(request("alice"))).text()).toBe("alice");
  });

  it("sends headers chosen per refusal, such as a challenge on the 401 only", async () => {
    const auth = Authentication.middleware(
      Identity,
      Effect.gen(function* () {
        const token = (yield* HttpServerRequest.HttpServerRequest).headers.authorization;

        if (token === undefined) return yield* new Unauthorized({ message: "Missing token" });

        return yield* new Forbidden({ message: "Denied token" });
      }),
      {
        errors: [Unauthorized, Forbidden],
        headers: (error) =>
          Schema.is(Unauthorized)(error) ? { "www-authenticate": "Bearer" } : {},
      },
    );

    const web = serve(
      HttpRouter.add("GET", "/identity", HttpServerResponse.text("unreachable")).pipe(
        Layer.provide(auth.layer),
      ),
    );

    onTestFinished(() => web.dispose());

    const [missing, denied] = await Promise.all([
      web.handler(request()),
      web.handler(request("denied")),
    ]);

    expect([missing.status, missing.headers.get("www-authenticate")]).toEqual([401, "Bearer"]);
    expect([denied.status, denied.headers.has("www-authenticate")]).toEqual([403, false]);
  });

  it("answers a declared refusal without a status annotation with 500", async () => {
    class Unannotated extends Schema.TaggedError<Unannotated>()("Unannotated", {}) {}

    const auth = Authentication.middleware(Identity, Effect.fail(new Unannotated()), {
      errors: [Unannotated],
    });

    const web = serve(
      HttpRouter.add("GET", "/identity", HttpServerResponse.text("unreachable")).pipe(
        Layer.provide(auth.layer),
      ),
    );

    onTestFinished(() => web.dispose());

    const response = await web.handler(request());
    expect(response.status).toBe(500);
    expect(response.headers.has("www-authenticate")).toBe(false);
    expect(await response.json()).toEqual(Schema.encodeSync(Unannotated)(new Unannotated()));
  });

  it("answers an undeclared refusal with an empty 500, as a defect", async () => {
    const auth = Authentication.middleware(
      Identity,
      // @ts-expect-error `Forbidden` is not one of `errors`; plain JavaScript can still fail with it.
      Effect.fail(new Forbidden({ message: "Undeclared" })),
      { errors: [Unauthorized] },
    );

    const web = serve(
      HttpRouter.add("GET", "/identity", HttpServerResponse.text("unreachable")).pipe(
        Layer.provide(auth.layer),
      ),
    );

    onTestFinished(() => web.dispose());

    const response = await web.handler(request());
    expect(response.status).toBe(500);
    expect(await response.text()).toBe("");
  });

  it("keeps resources acquired by authentication alive for the handler and releases on handler failure", async () => {
    const events: string[] = [];

    const auth = Authentication.middleware(
      Identity,
      Effect.acquireRelease(
        Effect.sync(() => {
          events.push("acquire");

          return { id: "alice" };
        }),
        () =>
          Effect.sync(() => {
            events.push("release");
          }),
      ),
    );

    const web = serve(
      HttpRouter.add(
        "GET",
        "/identity",
        Effect.gen(function* () {
          expect((yield* Identity).id).toBe("alice");
          expect(events).toEqual(["acquire"]);
          events.push("handler");

          return yield* Effect.die(new Error("handler failed"));
        }),
      ).pipe(Layer.provide(auth.layer)),
    );

    onTestFinished(() => web.dispose());
    const response = await web.handler(request());
    expect(response.status).toBe(500);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(events).toEqual(["acquire", "handler", "release"]);
  });

  it("protects private errors serialized by enclosing middleware", async () => {
    const auth = Authentication.middleware(Identity, Effect.succeed({ id: "alice" }));

    const outer = HttpRouter.middleware<{ handles: Unauthorized }>()((effect) =>
      Effect.catch(effect, (error) =>
        Schema.is(Unauthorized)(error)
          ? Effect.succeed(
              HttpServerResponse.text(error.message, {
                status: 404,
                headers: { "cache-control": "public, max-age=60" },
              }),
            )
          : Effect.fail(error),
      ),
    );

    const web = serve(
      HttpRouter.add(
        "GET",
        "/identity",
        Effect.gen(function* () {
          const identity = yield* Identity;

          return yield* new Unauthorized({ message: `private data for ${identity.id}` });
        }),
      ).pipe(Layer.provide(auth.combine(outer).layer)),
    );

    onTestFinished(() => web.dispose());
    const response = await web.handler(request());
    expect(response.status).toBe(404);
    expect(await response.text()).toBe("private data for alice");
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("tracks and resolves authentication dependencies using native middleware composition", async () => {
    const auth = Authentication.middleware(
      Identity,
      Effect.gen(function* () {
        const tokens = yield* Tokens;
        const incoming = yield* HttpServerRequest.HttpServerRequest;

        return { id: `${tokens.prefix}${incoming.headers.authorization}` };
      }),
    );

    // Native middleware requires composition before its layer becomes available.
    const missing: string = auth.layer;
    void missing;

    const tokens = HttpRouter.middleware<{ provides: Tokens }>()((effect) =>
      Effect.provideService(effect, Tokens, { prefix: "actor:" }),
    );

    const web = serve(
      HttpRouter.add(
        "GET",
        "/identity",
        Effect.map(Identity, (actor) => HttpServerResponse.text(actor.id)),
      ).pipe(Layer.provide(auth.combine(tokens).layer)),
    );

    onTestFinished(() => web.dispose());
    expect(await (await web.handler(request("alice"))).text()).toBe("actor:alice");
  });

  it.each(["http", "mcp"] as const)(
    "closes asynchronous authentication resources after a successful %s response",
    async (transport) => {
      const events: string[] = [];
      const releasing = Effect.runSync(Deferred.make<void>());
      const allowRelease = Effect.runSync(Deferred.make<void>());
      const released = Effect.runSync(Deferred.make<void>());

      const auth = Authentication.middleware(
        Identity,
        Effect.acquireRelease(
          Effect.sync(() => {
            events.push("acquire");

            return { id: "alice" };
          }),
          () =>
            Effect.gen(function* () {
              yield* Deferred.succeed(releasing, undefined);
              yield* Deferred.await(allowRelease);
              events.push("release");
              yield* Deferred.succeed(released, undefined);
            }),
        ),
      );

      const Identify = Action.make("identify", {
        description: "Read the identity while its authentication resource is alive",
        access: "write",
        success: Schema.String,
      });

      const app = Action.implement(Identify, () =>
        Effect.gen(function* () {
          expect(events).toEqual(["acquire"]);
          events.push("handler");

          return (yield* Identity).id;
        }),
      );

      const routes =
        transport === "http"
          ? ActionHttp.layer(ActionHttp.make([Identify]), app)
          : ActionMcp.layerHttp(app, { name: "scope-test", version: "0" });

      const web = serve(routes.pipe(Layer.provide(auth.layer)));

      onTestFinished(async () => {
        await Effect.runPromise(Deferred.succeed(allowRelease, undefined));
        await web.dispose();
      });

      const response = await web.handler(
        transport === "http"
          ? new Request("http://localhost/api/identify", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: "{}",
            })
          : rawToolCall("identify"),
      );

      expect(response.status).toBe(200);
      expect(await response.text()).toContain("alice");
      // Web handlers resolve the Response before asynchronous request finalizers
      // finish; streaming responses begin cleanup when their body is consumed.
      await Effect.runPromise(Deferred.await(releasing));
      expect(events).toEqual(["acquire", "handler"]);
      await Effect.runPromise(Deferred.succeed(allowRelease, undefined));
      await Effect.runPromise(Deferred.await(released));
      expect(events).toEqual(["acquire", "handler", "release"]);
    },
  );
});

describe("Authentication.bearerToken", () => {
  const tokenOf = (authorization?: string) =>
    Effect.runSync(
      Effect.provideService(
        Authentication.bearerToken,
        HttpServerRequest.HttpServerRequest,
        HttpServerRequest.fromWeb(
          new Request("http://localhost/", {
            headers: authorization === undefined ? {} : { authorization },
          }),
        ),
      ),
    );

  it("reads the token of a Bearer authorization, whatever the scheme's case", () => {
    expect(tokenOf("Bearer alice")).toEqual(Option.some("alice"));
    expect(tokenOf("bearer alice")).toEqual(Option.some("alice"));
    expect(tokenOf("BEARER alice")).toEqual(Option.some("alice"));
  });

  it("is absent without an authorization, with another scheme, or without a token", () => {
    expect(tokenOf()).toEqual(Option.none());
    expect(tokenOf("Basic YWxpY2U6c2VjcmV0")).toEqual(Option.none());
    expect(tokenOf("Bearer")).toEqual(Option.none());
    expect(tokenOf("Bearer ")).toEqual(Option.none());
    expect(tokenOf("Bearer two tokens")).toEqual(Option.none());
  });
});
