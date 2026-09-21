import { expect, it, onTestFinished } from "vite-plus/test";
import { Console, Context, Effect, Exit, Layer, Schema } from "effect";
import { Command } from "effect/unstable/cli";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpRouter,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http";
import { OpenApi } from "effect/unstable/httpapi";
import * as Action from "../src/Action.js";
import * as ActionCliClient from "../src/ActionCliClient.js";
import * as ActionGroup from "../src/ActionGroup.js";
import * as ActionHttp from "../src/ActionHttp.js";
import * as Authentication from "../src/Authentication.js";
import { httpClient } from "../src/Testing.js";
import { capturingConsole, cliServices } from "./cli-services.js";

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

const Session = ActionGroup.make({ name: "session" }, WhoAmI);

const app = Session.implement({ whoAmI: () => Principal });

/** The surface answers 401 itself, so the contract declares it on every endpoint. */
const Guarded = ActionHttp.make({ apiPath: "/api", errors: [Unauthenticated] }, Session);

/** The same contract without that declaration, for contrast. */
const Bare = ActionHttp.make({ apiPath: "/api" }, Session);

const unauthenticated = HttpServerResponse.schemaJson(Unauthenticated)(
  new Unauthenticated({ message: "A bearer token is required." }),
  { status: 401, headers: { "www-authenticate": "Bearer" } },
).pipe(Effect.orDie);

const authentication = Authentication.middleware(
  Principal,
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;

    if (request.headers.authorization !== "Bearer ada") return yield* Effect.flip(unauthenticated);

    return "ada";
  }),
);

const serve = (http: typeof Guarded | typeof Bare) => {
  const web = HttpRouter.toWebHandler(
    http
      .layer(app)
      .pipe(Layer.provide(authentication.layer), Layer.provide(HttpServer.layerServices)),
    { disableLogger: true },
  );

  onTestFinished(() => web.dispose());

  return web;
};

const bearer = (token: string) => ({
  transformClient: HttpClient.mapRequest(HttpClientRequest.bearerToken(token)),
});

it("declares surface errors on every endpoint so a typed client decodes them", async () => {
  const web = serve(Guarded);

  const accepted = await Effect.runPromise(
    Effect.flatMap(httpClient(Guarded.api, web.handler, bearer("ada")), (client) =>
      client.session.whoAmI({ payload: {} }),
    ),
  );

  expect(accepted).toBe("ada");

  // `catchTag` compiles only because the binding declares the failure.
  const refused = await Effect.runPromise(
    Effect.flatMap(httpClient(Guarded.api, web.handler, bearer("nobody")), (client) =>
      client.session.whoAmI({ payload: {} }),
    ).pipe(Effect.catchTag("Unauthenticated", (failure) => Effect.succeed(failure))),
  );

  expect(refused).toBeInstanceOf(Unauthenticated);
  expect(refused).toHaveProperty("message", "A bearer token is required.");
});

it("leaves an undeclared surface error as a decoding failure", async () => {
  const web = serve(Bare);

  const refused = await Effect.runPromise(
    Effect.flip(
      Effect.flatMap(httpClient(Bare.api, web.handler, bearer("nobody")), (client) =>
        client.session.whoAmI({ payload: {} }),
      ),
    ),
  );

  expect(refused).not.toBeInstanceOf(Unauthenticated);
  expect(String(refused)).toContain("Decode error (401");
});

it("publishes surface errors in the OpenAPI document", () => {
  const responses = OpenApi.fromApi(Guarded.api).paths?.["/api/session/whoAmI"]?.post?.responses;

  expect(responses).toHaveProperty("200");
  expect(responses).toHaveProperty("401");
  expect(
    OpenApi.fromApi(Bare.api).paths?.["/api/session/whoAmI"]?.post?.responses,
  ).not.toHaveProperty("401");
});

it("does not repeat a schema an action already declares", () => {
  const Declared = ActionGroup.make(
    { name: "session", errors: [Unauthenticated] },
    Action.make("whoAmI", {
      description: "Name the authenticated principal",
      access: "read",
      success: Schema.String,
    }),
  );

  const both = ActionHttp.make({ apiPath: "/api", errors: [Unauthenticated] }, Declared);
  const responses = OpenApi.fromApi(both.api).paths?.["/api/session/whoAmI"]?.post?.responses;

  expect(Object.keys(responses ?? {}).sort()).toEqual(["200", "401"]);
});

it("decodes a surface error through ActionCliClient", async () => {
  const web = serve(Guarded);
  const output: string[] = [];

  const fetchLayer = FetchHttpClient.layer.pipe(
    Layer.provide(
      Layer.succeed(FetchHttpClient.Fetch, (input, init) =>
        web.handler(new Request(input, init), Context.empty()),
      ),
    ),
  );

  const command = ActionCliClient.command(Guarded, "session", "whoAmI", {
    connection: { baseUrl: "http://localhost" },
  });

  const exit = await Command.runWith(command, { version: "0" })([]).pipe(
    Effect.provide(fetchLayer),
    Effect.provide(cliServices),
    Effect.provideService(Console.Console, capturingConsole(output)),
    Effect.exit,
    Effect.runPromise,
  );

  expect(Exit.isFailure(exit)).toBe(true);
  expect(output).toEqual([]);
});
