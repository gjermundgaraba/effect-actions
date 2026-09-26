import { expect, it, onTestFinished } from "vite-plus/test";
import { Context, Effect, Layer, Schema, Stream } from "effect";
import { Command } from "effect/unstable/cli";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientError,
  HttpClientRequest,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http";
import { OpenApi } from "effect/unstable/httpapi";
import * as Action from "../src/Action.js";
import * as ActionCli from "../src/ActionCli.js";
import * as ActionHttp from "../src/ActionHttp.js";
import * as ActionMcp from "../src/ActionMcp.js";
import * as ActionToolkit from "../src/ActionToolkit.js";
import * as Authentication from "../src/Authentication.js";
import * as Testing from "../src/Testing.js";
import { against, httpClient, serve } from "./serve.js";
import { post } from "./requests.js";
import { cliServices, logged } from "./cli-services.js";

class Principal extends Context.Service<Principal, string>()("surface-errors/Principal") {}

const WhoAmI = Action.make("whoAmI", {
  description: "Name the authenticated principal",
  access: "read",
  success: Schema.String,
});

const Http = ActionHttp.make([WhoAmI]);

// Each refusal is a built-in error, answered as the JSON every endpoint declares; any
// other answer is a response of the host's own.
const authenticate = Authentication.make(
  Principal,
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;

    switch (request.headers.authorization) {
      case "Bearer ada":
        return "ada";
      case "Bearer banned":
        return yield* new Action.Forbidden({ message: "This account is suspended." });
      case "Bearer eager":
        return yield* Effect.fail(HttpServerResponse.text("Slow down", { status: 429 }));
      default:
        return yield* new Action.Unauthenticated({ message: "A bearer token is required." });
    }
  }),
);

const app = Action.implement(WhoAmI, () => Principal, { authenticate });

/** A refusal's JSON, as every surface sends it. */
const wire = Schema.encodeSync(Schema.Union([Action.Unauthenticated, Action.Forbidden]));

const authenticated = () => {
  const web = serve(ActionHttp.layer(Http, app));
  onTestFinished(() => web.dispose());

  return web;
};

const bearer = (token: string) => ({
  transformClient: HttpClient.mapRequest(HttpClientRequest.bearerToken(token)),
});

const withToken = (token: string) => {
  const request = post("/api/whoAmI");
  request.headers.set("authorization", `Bearer ${token}`);

  return request;
};

it("answers authentication refusals with the built-in errors' JSON", async () => {
  const web = authenticated();

  const unauthenticated = await web.handler(post("/api/whoAmI"));
  expect(unauthenticated.status).toBe(401);
  expect(unauthenticated.headers.get("www-authenticate")).toBe("Bearer");
  expect(unauthenticated.headers.get("cache-control")).toBe("no-store");
  expect(await unauthenticated.json()).toEqual(
    wire(new Action.Unauthenticated({ message: "A bearer token is required." })),
  );

  const forbidden = await web.handler(withToken("banned"));
  expect(forbidden.status).toBe(403);
  // A 403 is no challenge: the caller is known, and new credentials would not help.
  expect(forbidden.headers.has("www-authenticate")).toBe(false);
  expect(forbidden.headers.get("cache-control")).toBe("no-store");
  expect(await forbidden.json()).toEqual(
    wire(new Action.Forbidden({ message: "This account is suspended." })),
  );

  const own = await web.handler(withToken("eager"));
  expect(own.status).toBe(429);
  expect(await own.text()).toBe("Slow down");
});

it("decodes authentication refusals as typed failures of the client", async () => {
  const web = authenticated();

  const call = (token: string) =>
    Effect.flatMap(httpClient(Http, web, bearer(token)), (client) => client.whoAmI());

  expect(await Effect.runPromise(call("ada"))).toBe("ada");

  // `catchTag` compiles only because every endpoint declares the refusals.
  const unauthenticated = await call("nobody").pipe(
    Effect.catchTag("Unauthenticated", (failure) => Effect.succeed(failure)),
    Effect.runPromise,
  );

  expect(unauthenticated).toEqual(
    new Action.Unauthenticated({ message: "A bearer token is required." }),
  );

  const forbidden = await call("banned").pipe(
    Effect.catchTag("Forbidden", (failure) => Effect.succeed(failure)),
    Effect.runPromise,
  );

  expect(forbidden).toEqual(new Action.Forbidden({ message: "This account is suspended." }));

  // A response of the host's own is not in the contract: Effect's own error.
  const own = await Effect.runPromise(Effect.flip(call("eager")));
  expect(HttpClientError.isHttpClientError(own) && own.response?.status).toBe(429);
});

const Rename = Action.make("rename", {
  description: "Rename a note",
  access: "write",
  input: { name: Schema.String },
  success: Schema.String,
});

/** `Rename`, implemented behind a `before` hook refusing every call with `refusal`. */
const refusing = (refusal: Action.Refusal) =>
  Action.implement(Rename, ({ name }) => Effect.succeed(name), {
    before: () => Effect.fail(refusal),
  });

const refusals = [
  [new Action.Unauthenticated(), 401],
  [new Action.Forbidden({ message: "Requires notes:write." }), 403],
] as const;

it.each(refusals)(
  "answers a before hook's %s over HTTP with its status",
  async (refusal, status) => {
    const Notes = ActionHttp.make([Rename]);
    const web = serve(ActionHttp.layer(Notes, refusing(refusal)));

    onTestFinished(() => web.dispose());

    const response = await web.handler(post("/api/rename", { name: "draft" }));
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual(wire(refusal));
    // A 401 carries a challenge, as the authentication middleware's does.
    expect(response.headers.get("www-authenticate")).toBe(status === 401 ? "Bearer" : null);

    const refused = await Effect.runPromise(
      Effect.flip(Effect.flatMap(httpClient(Notes, web), (client) => client.rename({ name: "x" }))),
    );

    expect(refused).toEqual(refusal);
  },
);

it("challenges a handler's own 401, with no hook bound", async () => {
  const Guarded = Action.make("guarded", {
    description: "Refuses by itself",
    access: "read",
    success: Schema.String,
    errors: [Action.Unauthenticated],
  });

  const Notes = ActionHttp.make([Guarded]);

  const web = serve(
    ActionHttp.layer(
      Notes,
      Action.implement(Guarded, () => Effect.fail(new Action.Unauthenticated())),
    ),
  );

  onTestFinished(() => web.dispose());

  const response = await web.handler(post("/api/guarded"));
  expect(response.status).toBe(401);
  expect(response.headers.get("www-authenticate")).toBe("Bearer");
});

it.each(refusals)("returns a before hook's %s as an MCP tool's error", async (refusal) => {
  const web = serve(ActionMcp.layerHttp(refusing(refusal), { name: "test", version: "0" }));

  onTestFinished(() => web.dispose());

  // A refusal is decoded, exactly as the HTTP client decodes it.
  expect(await against(web, Effect.flip(Testing.mcpCall(Rename, { name: "draft" })))).toEqual(
    refusal,
  );
});

it.each(refusals)("returns a before hook's %s as a native tool's failure", async (refusal) => {
  const { toolkit, layer } = ActionToolkit.make(refusing(refusal));

  const results = await Effect.gen(function* () {
    const tools = yield* toolkit;

    return yield* Stream.runCollect(yield* tools.handle("rename", { name: "draft" }));
  }).pipe(Effect.provide(layer), Effect.scoped, Effect.runPromise);

  expect(results).toMatchObject([{ isFailure: true, result: refusal }]);
});

it("does not repeat a built-in error an action already declares", () => {
  const Declared = Action.make("whoAmI", {
    description: "Name the authenticated principal",
    access: "read",
    success: Schema.String,
    errors: [Action.Forbidden],
  });

  const declared = Action.implement(Declared, () => Effect.succeed("ada"));
  const { toolkit } = ActionToolkit.make(declared);
  expect(toolkit.tools.whoAmI.failureSchema.members).toEqual([
    Action.Forbidden,
    Action.Unauthenticated,
  ]);

  const responses = OpenApi.fromApi(ActionHttp.make([Declared]).api).paths?.["/api/whoAmI"]?.post
    ?.responses;

  expect(Object.keys(responses ?? {}).sort()).toEqual(["200", "400", "401", "403"]);
});

it("decodes a refusal through a remote ActionCli command", async () => {
  const web = authenticated();

  const fetchLayer = FetchHttpClient.layer.pipe(
    Layer.provide(
      Layer.succeed(FetchHttpClient.Fetch, (input, init) => web.handler(new Request(input, init))),
    ),
  );

  const command = ActionCli.command(Http, WhoAmI, { baseUrl: "http://localhost" });

  // The refusal is a typed failure of the command, not a decode error.
  const [failure, output] = await logged(
    Command.runWith(command, { version: "0" })([]).pipe(Effect.flip),
  ).pipe(Effect.provide(fetchLayer), Effect.provide(cliServices), Effect.runPromise);

  expect(failure).toEqual(new Action.Unauthenticated({ message: "A bearer token is required." }));
  expect(output).toEqual([]);
});

it("decodes two errors that share a status by their tag", async () => {
  class Rejected extends Schema.TaggedError<Rejected>()(
    "Rejected",
    { reason: Schema.String },
    { httpApiStatus: 403 },
  ) {}

  // Each action declares its own 403 beside the built-in `Forbidden` the hook raises.
  const Refuse = Action.make("refuse", {
    description: "Refused by the hook",
    access: "write",
    success: Schema.String,
    errors: [Rejected],
  });

  const Reject = Action.make("reject", {
    description: "Rejected by the handler",
    access: "read",
    success: Schema.String,
    errors: [Rejected],
  });

  const binding = ActionHttp.make([Refuse, Reject]);

  const web = serve(
    ActionHttp.layer(
      binding,
      Action.implement(
        [Refuse, Reject],
        {
          refuse: () => Effect.succeed("unreachable"),
          reject: () => Effect.fail(new Rejected({ reason: "closed" })),
        },
        {
          before: (action) =>
            action.access === "read" ? Effect.void : Effect.fail(new Action.Forbidden()),
        },
      ),
    ),
  );

  onTestFinished(() => web.dispose());

  const refused = await Effect.runPromise(
    Effect.flatMap(httpClient(binding, web), (client) =>
      Effect.all([Effect.flip(client.refuse()), Effect.flip(client.reject())]),
    ),
  );

  // Both are reachable from each endpoint under 403; the tag selects the decoder.
  expect(refused).toEqual([new Action.Forbidden(), new Rejected({ reason: "closed" })]);

  const responses = OpenApi.fromApi(binding.api).paths?.["/api/refuse"]?.post?.responses;
  expect(Object.keys(responses ?? {}).sort()).toEqual(["200", "400", "401", "403"]);
});
