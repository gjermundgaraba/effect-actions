import { McpProtocol } from "effect/unstable/ai";
import { describe, expect, it, onTestFinished } from "vite-plus/test";
import { Context, Deferred, Effect, Layer, Schema } from "effect";
import {
  HttpRouter,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http";
import * as Action from "../src/Action.js";
import * as ActionGroup from "../src/ActionGroup.js";
import * as ActionHttp from "../src/ActionHttp.js";
import * as ActionMcp from "../src/ActionMcp.js";
import * as Authentication from "../src/Authentication.js";
import { mcpRequest } from "../src/Testing.js";
import { testApiPath, testMcpPath, testMcpUrl } from "./server.js";

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
        success: Schema.String,
      });

      const app = ActionGroup.make({ name: "test" }, Identify).implement({
        identify: () =>
          Effect.gen(function* () {
            expect(events).toEqual(["acquire"]);
            events.push("handler");

            return (yield* Identity).id;
          }),
      });

      const routes =
        transport === "http"
          ? ActionHttp.make({ apiPath: testApiPath }, app.group).layer(app)
          : ActionMcp.layer(
              {
                protocols: [McpProtocol.v2026_07_28],
                name: "scope-test",
                version: "0",
                path: testMcpPath,
              },
              app,
            );

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
          : mcpRequest({
              url: testMcpUrl,
              method: "tools/call",
              params: { name: "identify", arguments: {} },
            }),
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
