import { expect, it } from "@effect/vitest";
import { Context, Effect, Layer, Option, Redacted, Schema } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/http";
import { HttpApiMiddleware } from "effect/http-api";
import * as Action from "../../src/contract/Action.js";
import * as ActionHttp from "../../src/http/ActionHttp.js";
import * as Authentication from "../../src/authentication/Authentication.js";
import { post, withBearer } from "../support/requests.js";
import { serve } from "../support/serve.js";
import {
  Actor,
  app,
  authenticate,
  Http,
  Login,
  Public,
  resolveTenant,
  Who,
} from "../support/tenant.js";

class LogCallerOrAnonymous extends HttpApiMiddleware.Service<LogCallerOrAnonymous>()(
  "layer-middleware/LogCaller",
) {}

const logCaller = (seen: Array<string>) =>
  Layer.succeed(LogCallerOrAnonymous, (route) =>
    Effect.flatMap(Effect.serviceOption(Actor), (actor) => {
      const caller = Option.getOrElse(actor, () => "anonymous");
      seen.push(caller);

      return Effect.map(route, HttpServerResponse.setHeader("x-caller", caller));
    }),
  );

it("runs a layer's middleware inside the authentication and outside decoding, never for a refusal", async () => {
  const seen: Array<string> = [];

  const web = serve(
    ActionHttp.layer(Http, app, { middleware: [LogCallerOrAnonymous] }).pipe(
      Layer.provide([authenticate, logCaller(seen)]),
      Layer.provide(resolveTenant.layer),
    ),
  );

  const signedIn = (body: string) =>
    new Request("http://localhost/api/who", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer alice",
        "x-tenant": "acme",
      },
      body,
    });

  const ok = await web.handler(signedIn("{}"));
  expect([ok.status, ok.headers.get("x-caller"), await ok.json()]).toEqual([
    200,
    "acme:alice",
    "acme:alice",
  ]);

  const malformedBodyPastMiddleware = await web.handler(signedIn("{"));
  expect([
    malformedBodyPastMiddleware.status,
    malformedBodyPastMiddleware.headers.get("x-caller"),
  ]).toEqual([400, null]);
  expect(seen).toEqual(["acme:alice", "acme:alice"]);

  const refused = await web.handler(post("/api/who"));
  expect([refused.status, refused.headers.get("x-caller")]).toEqual([401, null]);

  const publicRouteWithoutIdentity = await web.handler(post("/api/public"));
  expect([
    publicRouteWithoutIdentity.status,
    publicRouteWithoutIdentity.headers.get("x-caller"),
  ]).toEqual([200, "anonymous"]);

  expect(seen).toEqual(["acme:alice", "acme:alice", "anonymous"]);
});

class NamesCaller extends HttpApiMiddleware.Service<NamesCaller, { requires: Actor }>()(
  "layer-middleware/NamesCaller",
) {}

it("serves a mixed implementation's protected actions behind middleware reading the identity, its public ones apart", async () => {
  const web = serve(
    Layer.mergeAll(
      ActionHttp.layer(Http, app, { actions: [Who], middleware: [NamesCaller] }),
      ActionHttp.layer(Http, app, { actions: [Public] }),
    ).pipe(
      Layer.provide([
        authenticate,
        Layer.succeed(NamesCaller, (route) =>
          Effect.flatMap(Actor, (actor) =>
            Effect.map(route, HttpServerResponse.setHeader("x-caller", actor)),
          ),
        ),
      ]),
      Layer.provide(resolveTenant.layer),
    ),
  );

  const who = await web.handler(withBearer(post("/api/who"), "alice"));
  expect([who.status, who.headers.get("x-caller")]).toEqual([200, "default:alice"]);

  const publicRouteWithoutIdentity = await web.handler(post("/api/public"));
  expect([
    publicRouteWithoutIdentity.status,
    publicRouteWithoutIdentity.headers.get("x-caller"),
    await publicRouteWithoutIdentity.json(),
  ]).toEqual([200, null, "public"]);
});

class Region extends Context.Service<Region, string>()("layer-middleware/Region") {}

class NeedsRegion extends HttpApiMiddleware.Service<NeedsRegion, { requires: Region }>()(
  "layer-middleware/NeedsRegion",
) {}

class GivesRegion extends HttpApiMiddleware.Service<GivesRegion, { provides: Region }>()(
  "layer-middleware/GivesRegion",
) {}

it("feeds what an outer middleware provides to an inner one, the first listed innermost", async () => {
  const order: Array<string> = [];

  const web = serve(
    ActionHttp.layer(ActionHttp.make([Public]), app, {
      middleware: [NeedsRegion, GivesRegion],
    }).pipe(
      Layer.provide([
        Layer.succeed(GivesRegion, (route) =>
          Effect.sync(() => order.push("gives")).pipe(
            Effect.andThen(Effect.provideService(route, Region, "eu")),
          ),
        ),
        Layer.succeed(NeedsRegion, (route) =>
          Effect.flatMap(Region, (region) =>
            Effect.sync(() => order.push("needs")).pipe(
              Effect.andThen(Effect.map(route, HttpServerResponse.setHeader("x-region", region))),
            ),
          ),
        ),
      ]),
    ),
  );

  const response = await web.handler(post("/api/public"));
  expect([response.status, response.headers.get("x-region")]).toEqual([200, "eu"]);
  expect(order).toEqual(["gives", "needs"]);
});

it("refuses a middleware listed twice, which native endpoints would install once", () => {
  expect(() =>
    ActionHttp.layer(ActionHttp.make([Public]), app, {
      middleware: [LogCallerOrAnonymous, LogCallerOrAnonymous],
    }),
  ).toThrow("Duplicate middleware: layer-middleware/LogCaller");
});

class Throttled extends Schema.TaggedError<Throttled>()("Throttled", {}, { httpApiStatus: 429 }) {}

class CallerQuotaBeforeDecoding extends HttpApiMiddleware.Service<
  CallerQuotaBeforeDecoding,
  { requires: Actor }
>()("layer-middleware/Quota", { error: Throttled }) {}

it("answers a binding's error a layer middleware fails with, before decoding, as every client decodes it", async () => {
  const counted: Array<string> = [];

  const Limited = ActionHttp.make([Who], { authentication: Login, error: [Throttled] });

  const web = serve(
    ActionHttp.layer(Limited, app, { middleware: [CallerQuotaBeforeDecoding] }).pipe(
      Layer.provide([
        authenticate,
        Layer.succeed(CallerQuotaBeforeDecoding, (route) =>
          Effect.flatMap(Actor, (actor) => {
            counted.push(actor);

            return counted.length > 1 ? Effect.fail(new Throttled()) : Effect.void;
          }).pipe(Effect.andThen(route)),
        ),
      ]),
      Layer.provide(resolveTenant.layer),
    ),
  );

  const request = (body: string) =>
    new Request("http://localhost/api/who", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer alice" },
      body,
    });

  expect((await web.handler(request("{"))).status).toBe(400);

  const throttled = await web.handler(request("{}"));
  expect(throttled.status).toBe(429);
  expect(Schema.decodeUnknownSync(Throttled)(await throttled.json())).toBeInstanceOf(Throttled);
  expect(counted).toEqual(["default:alice", "default:alice"]);
});

class Unavailable extends Schema.TaggedError<Unavailable>()(
  "Unavailable",
  { message: Schema.String },
  { httpApiStatus: 503 },
) {}

class MaskEveryFailureAsUnavailable extends HttpApiMiddleware.Service<MaskEveryFailureAsUnavailable>()(
  "layer-middleware/Mask",
  {
    error: Unavailable,
  },
) {}

class FallbackOnEveryFailure extends HttpApiMiddleware.Service<FallbackOnEveryFailure>()(
  "layer-middleware/Fallback",
) {}

it("answers a step-up refusal as it leaves the layer's middleware, which may recover from it or replace it", async () => {
  const Edit = Action.make("edit", { description: "Edit", readOnly: false, caller: Actor });

  const editing = Action.implement(
    Edit,
    () => Effect.fail(new Action.Forbidden({ message: "Needs write.", scopes: ["write"] })),
    { authorize: Action.allowAll },
  );

  const Editing = ActionHttp.make([Edit], { authentication: Login });
  const verify = Authentication.layer(Login, (token) => Effect.succeed(Redacted.value(token)));

  const fallback = Layer.succeed(FallbackOnEveryFailure, (route) =>
    Effect.catch(route, () => Effect.succeed(HttpServerResponse.text("fallback"))),
  );

  const recovering = serve(
    ActionHttp.layer(Editing, editing, { middleware: [FallbackOnEveryFailure] }).pipe(
      Layer.provide([verify, fallback]),
    ),
  );

  const recovered = await recovering.handler(withBearer(post("/api/edit"), "alice"));
  expect([recovered.status, await recovered.text()]).toEqual([200, "fallback"]);

  const Masking = ActionHttp.make([Edit], { authentication: Login, error: [Unavailable] });

  const mask = Layer.succeed(MaskEveryFailureAsUnavailable, (route) =>
    Effect.catch(route, () => Effect.fail(new Unavailable({ message: "Try later." }))),
  );

  const masking = serve(
    ActionHttp.layer(Masking, editing, { middleware: [MaskEveryFailureAsUnavailable] }).pipe(
      Layer.provide([verify, mask]),
    ),
  );

  const masked = await masking.handler(withBearer(post("/api/edit"), "alice"));

  expect([masked.status, masked.headers.get("www-authenticate")]).toEqual([503, null]);
  expect(Schema.decodeUnknownSync(Unavailable)(await masked.json())).toEqual(
    new Unavailable({ message: "Try later." }),
  );

  const withoutLayerMiddleware = serve(
    ActionHttp.layer(Editing, editing).pipe(Layer.provide(verify)),
  );

  const refused = await withoutLayerMiddleware.handler(withBearer(post("/api/edit"), "alice"));

  expect(refused.status).toBe(403);
  expect(refused.headers.get("www-authenticate")).toContain('scope="write"');
});

class AddressAllowlist extends HttpApiMiddleware.Service<AddressAllowlist>()(
  "layer-middleware/Allowlist",
  {
    error: Action.Forbidden,
  },
) {}

it("lets a layer's middleware fail with a built-in error, which every client decodes", async () => {
  const web = serve(
    ActionHttp.layer(Http, app, { middleware: [AddressAllowlist] }).pipe(
      Layer.provide([
        authenticate,
        Layer.succeed(AddressAllowlist, (route) =>
          Effect.flatMap(HttpServerRequest.HttpServerRequest, (request) =>
            request.headers["x-forwarded-for"] === "10.0.0.1"
              ? Effect.void
              : Effect.fail(new Action.Forbidden({ message: "Address not allowed." })),
          ).pipe(Effect.andThen(route)),
        ),
      ]),
      Layer.provide(resolveTenant.layer),
    ),
  );

  for (const sent of [post("/api/public"), withBearer(post("/api/who"), "alice")]) {
    sent.headers.set("x-tenant", "acme");

    const refused = await web.handler(sent);
    expect(refused.status).toBe(403);
    expect(Schema.decodeUnknownSync(Action.Forbidden)(await refused.json())).toMatchObject({
      message: "Address not allowed.",
    });
  }

  const allowed = post("/api/public");
  allowed.headers.set("x-forwarded-for", "10.0.0.1");
  expect((await web.handler(allowed)).status).toBe(200);
});
