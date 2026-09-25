import { expect, it, onTestFinished } from "vite-plus/test";
import { Context, Effect, Layer, Schema } from "effect";
import { Command } from "effect/unstable/cli";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpServerRequest,
} from "effect/unstable/http";
import { OpenApi } from "effect/unstable/httpapi";
import * as Action from "../src/Action.js";
import * as ActionCli from "../src/ActionCli.js";
import * as ActionHttp from "../src/ActionHttp.js";
import * as ActionToolkit from "../src/ActionToolkit.js";
import * as Authentication from "../src/Authentication.js";
import { httpClient, serve } from "../src/Testing.js";
import { cliServices, logged } from "./cli-services.js";

class Principal extends Context.Service<Principal, string>()("surface-errors/Principal") {}

class Unauthenticated extends Schema.TaggedError<Unauthenticated>()(
  "Unauthenticated",
  { message: Schema.String },
  { httpApiStatus: 401 },
) {}

const WhoAmI = Action.make("whoAmI", {
  description: "Name the authenticated principal",
  access: "read",
  success: Schema.String,
});

const app = Action.implement(WhoAmI, () => Principal);

/** The surface answers 401 itself, so the contract declares it on every endpoint. */
const Guarded = ActionHttp.make([WhoAmI], { errors: [Unauthenticated] });

/** The same contract without that declaration, for contrast. */
const Bare = ActionHttp.make([WhoAmI]);

// The middleware answers with the declared error, encoded as the binding declares it.
const authentication = Authentication.middleware(
  Principal,
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;

    if (request.headers.authorization !== "Bearer ada") {
      return yield* new Unauthenticated({ message: "A bearer token is required." });
    }

    return "ada";
  }),
  { errors: [Unauthenticated], headers: { "www-authenticate": "Bearer" } },
);

/** Each binding is served on its own: their layers differ in the errors they declare. */
const authenticated = (http: typeof Guarded | typeof Bare) => {
  const web = serve(ActionHttp.layer(http, app).pipe(Layer.provide(authentication.layer)));
  onTestFinished(() => web.dispose());

  return web;
};

const guarded = () => authenticated(Guarded);

const bare = () => authenticated(Bare);

const bearer = (token: string) => ({
  transformClient: HttpClient.mapRequest(HttpClientRequest.bearerToken(token)),
});

it("declares surface errors on every endpoint so a typed client decodes them", async () => {
  const web = guarded();

  const accepted = await Effect.runPromise(
    Effect.flatMap(httpClient(Guarded, web.handler, bearer("ada")), (client) => client.whoAmI()),
  );

  expect(accepted).toBe("ada");

  // `catchTag` compiles only because the binding declares the failure.
  const refused = await Effect.runPromise(
    Effect.flatMap(httpClient(Guarded, web.handler, bearer("nobody")), (client) =>
      client.whoAmI(),
    ).pipe(Effect.catchTag("Unauthenticated", (failure) => Effect.succeed(failure))),
  );

  expect(refused).toBeInstanceOf(Unauthenticated);
  expect(refused).toHaveProperty("message", "A bearer token is required.");
});

it("leaves an undeclared surface error as a decoding failure", async () => {
  const web = bare();

  const refused = await Effect.runPromise(
    Effect.flip(
      Effect.flatMap(httpClient(Bare, web.handler, bearer("nobody")), (client) => client.whoAmI()),
    ),
  );

  expect(refused).not.toBeInstanceOf(Unauthenticated);
  expect(String(refused)).toContain("Decode error (401");
});

it("publishes surface errors in the OpenAPI document", () => {
  const responses = OpenApi.fromApi(Guarded.api).paths?.["/api/whoAmI"]?.post?.responses;

  expect(responses).toHaveProperty("200");
  expect(responses).toHaveProperty("401");
  expect(OpenApi.fromApi(Bare.api).paths?.["/api/whoAmI"]?.post?.responses).not.toHaveProperty(
    "401",
  );
});

it("does not repeat a schema an action already declares", () => {
  const Declared = Action.make("whoAmI", {
    description: "Name the authenticated principal",
    access: "read",
    success: Schema.String,
    errors: [Unauthenticated],
  });

  const app = Action.implement(Declared, () => Effect.succeed("ada"));
  const binding = ActionToolkit.make(app, { errors: [Unauthenticated, Unauthenticated] });
  expect(binding.toolkit.tools.whoAmI.failureSchema.members).toEqual([Unauthenticated]);

  const both = ActionHttp.make([Declared], { errors: [Unauthenticated] });
  const responses = OpenApi.fromApi(both.api).paths?.["/api/whoAmI"]?.post?.responses;

  expect(Object.keys(responses ?? {}).sort()).toEqual(["200", "401"]);
});

it("decodes a surface error through a remote ActionCli command", async () => {
  const web = guarded();

  const fetchLayer = FetchHttpClient.layer.pipe(
    Layer.provide(
      Layer.succeed(FetchHttpClient.Fetch, (input, init) => web.handler(new Request(input, init))),
    ),
  );

  const command = ActionCli.command(Guarded, WhoAmI, { baseUrl: "http://localhost" });

  // The surface error is a typed failure of the command, not a decode error.
  const [failure, output] = await logged(
    Command.runWith(command, { version: "0" })([]).pipe(Effect.flip),
  ).pipe(Effect.provide(fetchLayer), Effect.provide(cliServices), Effect.runPromise);

  expect(failure).toBeInstanceOf(Unauthenticated);
  expect(failure).toHaveProperty("message", "A bearer token is required.");
  expect(output).toEqual([]);
});

it("decodes two errors that share a status by their tag", async () => {
  class Throttled extends Schema.TaggedError<Throttled>()(
    "Throttled",
    { retryAfter: Schema.Finite },
    { httpApiStatus: 403 },
  ) {}

  class Rejected extends Schema.TaggedError<Rejected>()(
    "Rejected",
    { reason: Schema.String },
    { httpApiStatus: 403 },
  ) {}

  // The action declares one 403; the surface declares another, and the hook raises it.
  const Refuse = Action.make("refuse", {
    description: "Refuse in two different ways",
    access: "write",
    input: { byHandler: Schema.Boolean },
    success: Schema.String,
    errors: [Rejected],
  });

  const binding = ActionHttp.make([Refuse], { errors: [Throttled] });

  const web = serve(
    ActionHttp.layer(
      binding,
      Action.implement(Refuse, () => Effect.fail(new Rejected({ reason: "closed" }))),
      {
        before: (action) =>
          action.access === "read" ? Effect.void : Effect.fail(new Throttled({ retryAfter: 30 })),
      },
    ),
  );

  onTestFinished(() => web.dispose());

  const refused = await Effect.runPromise(
    Effect.flip(
      Effect.flatMap(httpClient(binding, web.handler), (client) =>
        client.refuse({ byHandler: true }),
      ),
    ),
  );

  // Both are reachable from this endpoint under 403; the tag selects the decoder.
  expect(refused).toBeInstanceOf(Throttled);
  expect(refused).toHaveProperty("retryAfter", 30);

  const responses = OpenApi.fromApi(binding.api).paths?.["/api/refuse"]?.post?.responses;
  expect(Object.keys(responses ?? {}).sort()).toEqual(["200", "403"]);
});
