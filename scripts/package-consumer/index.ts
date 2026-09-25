import * as Action from "@gjermundgaraba/effect-actions/Action";
import * as ActionCli from "@gjermundgaraba/effect-actions/ActionCli";
import * as ActionHttp from "@gjermundgaraba/effect-actions/ActionHttp";
import * as ActionHttpClient from "@gjermundgaraba/effect-actions/ActionHttpClient";
import * as ActionToolkit from "@gjermundgaraba/effect-actions/ActionToolkit";
import type { HttpApiClient } from "effect/unstable/httpapi";
import * as Authentication from "@gjermundgaraba/effect-actions/Authentication";
import * as Testing from "@gjermundgaraba/effect-actions/Testing";
import { Context, Effect, Layer, Option, Schema, Stream } from "effect";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";
import { Greet, Http, routes } from "./quickstart.js";

// Subpaths are the only entry points: one module each, so nothing loads the MCP
// server by accident.
const packageRoot: string = "@gjermundgaraba/effect-actions";

const rootImport = await import(packageRoot).then(
  () => "resolved",
  () => "absent",
);

if (rootImport !== "absent") throw new Error("The package root must not be an entry point");

const checkTypes = (client: HttpApiClient.ForApi<typeof Http.api>) => {
  // @ts-expect-error Published declarations must reject incorrect input.
  client.greet({ payload: { name: 123 } });

  // @ts-expect-error Published declarations must retain the result type.
  const wrong: Effect.Effect<number, unknown, unknown> = client.greet({
    payload: { name: "Ada" },
  });

  return wrong;
};

void checkTypes;

const served = await Effect.gen(function* () {
  // `Testing.layer` resolves the relative URL, so the client needs no `baseUrl`.
  const client = yield* ActionHttpClient.make(Http);

  const checkClientTypes = () => {
    // @ts-expect-error Published declarations must type the client's input.
    void client.greet({ name: 123 });

    // @ts-expect-error Published declarations must retain the client's result type.
    const wrong: Effect.Effect<number, unknown> = client.greet({ name: "Ada" });

    return wrong;
  };

  void checkClientTypes;

  const greeting = yield* client.greet({ name: "Ada" });
  const called = yield* Testing.mcpCall({ name: "greet", arguments: { name: "Ada" } });

  return { greeting, called };
}).pipe(Effect.provide(Testing.layer(routes)), Effect.runPromise);

if (served.greeting !== "Hello, Ada!") throw new Error(`Unexpected greeting: ${served.greeting}`);

if (served.called.isError || served.called.value !== "Hello, Ada!")
  throw new Error("MCP tool call failed");

/** The status of a GET to `url`, answered in memory by `Testing.layer`. */
const statusOf = (client: Layer.Layer<HttpClient.HttpClient>, url: string) =>
  HttpClient.get(url).pipe(
    Effect.map((response) => response.status),
    Effect.provide(client),
    Effect.runPromise,
  );

if ((await statusOf(Testing.layer(ActionHttp.openApi(Http)), "/api/openapi.json")) !== 200)
  throw new Error("The OpenAPI route failed");

const discovery = Authentication.protectedResource({
  resource: "http://localhost/mcp",
  authorizationServers: ["https://example.com/auth"],
});

if ((await statusOf(Testing.layer(discovery), "/.well-known/oauth-protected-resource/mcp")) !== 200)
  throw new Error("The discovery route failed");

const greet = Action.implement(Greet, ({ name }) => Effect.succeed(`Hello, ${name}!`));

const binding = ActionToolkit.make(greet);

const checkToolkitTypes = () => {
  // @ts-expect-error Published Toolkit names must remain literal.
  void binding.toolkit.tools.missing;
};

void checkToolkitTypes;

const toolResults = await Effect.gen(function* () {
  const tools = yield* binding.toolkit;

  return yield* tools.handle("greet", { name: "Ada" }).pipe(Effect.flatMap(Stream.runCollect));
}).pipe(Effect.provide(binding.layer), Effect.runPromise);

if (toolResults[0]?.result !== "Hello, Ada!") throw new Error("Native Toolkit projection failed");

const localCommand = ActionCli.make(greet, { name: "greetings" });

if (localCommand.name !== "greetings") throw new Error("Local CLI projection failed");

const remoteCommand = ActionCli.make(Http, { name: "greetings" });

if (remoteCommand.name !== "greetings") throw new Error("Remote CLI projection failed");

const configuredCommand = ActionCli.command(greet, Greet, {
  render: (greeting) => greeting.toUpperCase(),
});

if (configuredCommand.name !== "greet") throw new Error("Configured CLI projection failed");

const configuredRemote = ActionCli.command(Http, Greet, {
  name: "hello",
  render: (greeting) => greeting.toUpperCase(),
});

if (configuredRemote.name !== "hello") throw new Error("Configured remote CLI projection failed");

const Read = Action.make("read", { description: "Read", access: "read", success: Schema.String });

const Write = Action.make("write", {
  description: "Write",
  access: "write",
  success: Schema.String,
});

const checkCliTypes = () => {
  // @ts-expect-error Remote commands accept only the binding's own actions.
  ActionCli.command(Http, Read);
};

void checkCliTypes;

if (Read.access !== "read" || Write.access !== "write")
  throw new Error("Published access metadata failed");

class Identity extends Context.Service<Identity, string>()("consumer/Identity") {}

const guarded = Action.implement([Read, Write], {
  read: () => Effect.map(Identity, (identity) => identity),
  write: () => Effect.succeed("write"),
});

const GuardedHttp = ActionHttp.make([Read, Write]);

class Denied extends Schema.TaggedError<Denied>()("Denied", {}) {}

const checkHookTypes = () => {
  // @ts-expect-error A published hook refuses only with a built-in refusal.
  ActionHttp.layer(GuardedHttp, guarded, { before: () => Effect.fail(new Denied()) });
};

void checkHookTypes;

const authentication = Authentication.middleware(
  Identity,
  Effect.flatMap(Authentication.bearerToken, (token) =>
    Option.match(token, {
      onNone: () => Effect.fail(new Action.Unauthenticated({ message: "Sign in." })),
      onSome: Effect.succeed,
    }),
  ),
);

const guardedRoutes = ActionHttp.layer(GuardedHttp, guarded, {
  before: (action) =>
    action.access === "read"
      ? Effect.void
      : Effect.fail(new Action.Forbidden({ message: "Read only." })),
}).pipe(Layer.provide(authentication.layer));

const refusals = await Effect.gen(function* () {
  const anonymous = yield* ActionHttpClient.make(GuardedHttp);

  const client = yield* ActionHttpClient.make(GuardedHttp, {
    transformClient: HttpClient.mapRequest(HttpClientRequest.bearerToken("ada")),
  });

  const checkErrorTypes = () =>
    client.read().pipe(
      Effect.catchTag("Unauthenticated", () => Effect.succeed("")),
      Effect.catchTag("Forbidden", () => Effect.succeed("")),
      Effect.catchTag("InvalidInput", () => Effect.succeed("")),
      // @ts-expect-error Published clients must type their failures precisely.
      Effect.catchTag("Denied", () => Effect.succeed("")),
    );

  void checkErrorTypes;

  return {
    identity: yield* client.read(),
    unauthenticated: yield* Effect.flip(anonymous.read()),
    forbidden: yield* Effect.flip(client.write()),
  };
}).pipe(Effect.provide(Testing.layer(guardedRoutes)), Effect.runPromise);

if (refusals.identity !== "ada") throw new Error("Published middleware lost the identity");

if (!(refusals.unauthenticated instanceof Action.Unauthenticated))
  throw new Error("Published middleware allowed an anonymous read");

if (
  !(refusals.forbidden instanceof Action.Forbidden) ||
  refusals.forbidden.message !== "Read only."
)
  throw new Error("Published hook allowed a write");
