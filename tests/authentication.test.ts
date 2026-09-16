import { describe, expect, it, onTestFinished } from "vite-plus/test";
import { Context, Deferred, Effect, Layer, Schema, SchemaTransformation } from "effect";
import {
  HttpRouter,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http";
import { Action, ActionGroup, ActionHttp, ActionMcp, Authentication } from "../src/index.js";
import { mcpRequest } from "../src/Testing.js";

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

const serve = (routes: Layer.Layer<never, never, HttpRouter.HttpRouter>) =>
  HttpRouter.toWebHandler(routes.pipe(Layer.provide(HttpServer.layerServices)), {
    disableLogger: true,
  });

const request = (token?: string) =>
  new Request("http://localhost/identity", {
    headers: token === undefined ? {} : { authorization: token },
  });

describe("Authentication.middleware", () => {
  it("encodes declared acquisition errors with each schema's status and challenge headers", async () => {
    let calls = 0;
    const auth = Authentication.middleware(Identity, {
      errors: [Unauthorized, Forbidden],
      authenticate: Effect.gen(function* () {
        const token = (yield* HttpServerRequest.HttpServerRequest).headers.authorization;
        if (token === undefined) return yield* new Unauthorized({ message: "Missing token" });
        if (token === "denied") return yield* new Forbidden({ message: "Denied token" });
        return { id: token };
      }),
      headers: (error) => ({ "www-authenticate": `Bearer error="${error._tag}"` }),
    });
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

  it.each([
    ["", 500],
    ["first-wire", 401],
  ] as const)(
    "uses only the first matching error codec when it encodes to %j",
    async (firstWire, expectedStatus) => {
      const encodes: string[] = [];
      const first = Schema.String.check(Schema.isMinLength(1)).pipe(
        Schema.decodeTo(
          Schema.String,
          SchemaTransformation.transform({
            decode: (value: string) => value,
            encode: (): string => {
              encodes.push("first");
              return firstWire;
            },
          }),
        ),
        Schema.annotate({ httpApiStatus: 401 }),
      );
      const second = Schema.String.pipe(
        Schema.decodeTo(
          Schema.String,
          SchemaTransformation.transform({
            decode: (value: string) => value,
            encode: (): string => {
              encodes.push("second");
              return "second-wire";
            },
          }),
        ),
        Schema.annotate({ httpApiStatus: 403 }),
      );
      const auth = Authentication.middleware(Identity, {
        errors: [first, second],
        authenticate: Effect.fail("authentication failed"),
      });
      const web = serve(
        HttpRouter.add("GET", "/identity", HttpServerResponse.empty()).pipe(
          Layer.provide(auth.layer),
        ),
      );
      onTestFinished(() => web.dispose());
      const response = await web.handler(request());
      expect(response.status).toBe(expectedStatus);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(encodes).toEqual(["first"]);
      if (firstWire !== "") expect(await response.json()).toBe(firstWire);
    },
  );

  it("rejects an undeclared refined error before encoding or computing response headers", async () => {
    let headers = 0;
    const auth = Authentication.middleware(Identity, {
      errors: [Schema.String.check(Schema.isMinLength(1)).annotate({ httpApiStatus: 401 })],
      authenticate: Effect.fail(""),
      headers: () => {
        headers++;
        return { "www-authenticate": "Bearer" };
      },
    });
    const web = serve(
      HttpRouter.add("GET", "/identity", HttpServerResponse.empty()).pipe(
        Layer.provide(auth.layer),
      ),
    );
    onTestFinished(() => web.dispose());
    const response = await web.handler(request());
    expect(response.status).toBe(500);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(headers).toBe(0);
    expect(response.headers.get("www-authenticate")).toBeNull();
  });

  it("defaults an unannotated declared error to HTTP 500", async () => {
    const auth = Authentication.middleware(Identity, {
      errors: [Schema.String],
      authenticate: Effect.fail("authentication failed"),
    });
    const web = serve(
      HttpRouter.add("GET", "/identity", HttpServerResponse.empty()).pipe(
        Layer.provide(auth.layer),
      ),
    );
    onTestFinished(() => web.dispose());
    const response = await web.handler(request());
    expect(response.status).toBe(500);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toBe("authentication failed");
  });

  it("keeps resources acquired by authentication alive for the handler and releases on handler failure", async () => {
    const events: string[] = [];
    const auth = Authentication.middleware(Identity, {
      errors: [Unauthorized],
      authenticate: Effect.acquireRelease(
        Effect.sync(() => {
          events.push("acquire");
          return { id: "alice" };
        }),
        () =>
          Effect.sync(() => {
            events.push("release");
          }),
      ),
    });
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
    const auth = Authentication.middleware(Identity, {
      errors: [Unauthorized],
      authenticate: Effect.succeed({ id: "alice" }),
    });
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
    const auth = Authentication.middleware(Identity, {
      errors: [Unauthorized],
      authenticate: Effect.gen(function* () {
        const tokens = yield* Tokens;
        const incoming = yield* HttpServerRequest.HttpServerRequest;
        return { id: `${tokens.prefix}${incoming.headers.authorization}` };
      }),
    });
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
      const auth = Authentication.middleware(Identity, {
        errors: [Unauthorized],
        authenticate: Effect.acquireRelease(
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
      });
      const Identify = Action.make("identify", {
        description: "Read the identity while its authentication resource is alive",
        success: Schema.String,
      });
      const app = ActionGroup.make(Identify).implement({
        identify: () =>
          Effect.gen(function* () {
            expect(events).toEqual(["acquire"]);
            events.push("handler");
            return (yield* Identity).id;
          }),
      });
      const routes =
        transport === "http"
          ? ActionHttp.layer(app)
          : ActionMcp.layer(app, { name: "scope-test", version: "0" });
      const web = HttpRouter.toWebHandler(
        routes.pipe(Layer.provide(auth.layer), Layer.provide(HttpServer.layerServices)),
        { disableLogger: true },
      );
      onTestFinished(async () => {
        await Effect.runPromise(Deferred.succeed(allowRelease, undefined));
        await web.dispose();
      });
      const response = await web.handler(
        transport === "http"
          ? new Request("http://localhost/api/actions/identify", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: "{}",
            })
          : mcpRequest("tools/call", { name: "identify", arguments: {} }),
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
