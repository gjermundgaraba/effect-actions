import * as ActionCatalog from "@gjermundgaraba/effect-actions/ActionCatalog";
import * as ActionCli from "@gjermundgaraba/effect-actions/ActionCli";
import * as ActionCliClient from "@gjermundgaraba/effect-actions/ActionCliClient";
import * as ActionToolkit from "@gjermundgaraba/effect-actions/ActionToolkit";
import type { HttpApiClient } from "effect/unstable/httpapi";
import * as Authentication from "@gjermundgaraba/effect-actions/Authentication";
import { httpClient, mcpRequest } from "@gjermundgaraba/effect-actions/Testing";
import { Effect, Layer, Stream } from "effect";
import { Argument } from "effect/unstable/cli";
import { HttpRouter, HttpServer } from "effect/unstable/http";
import { Actions, Http, routes } from "./quickstart.js";

// Subpaths are the only entry points: one module each, so nothing loads the MCP
// server or the optional client peer by accident.
const packageRoot: string = "@gjermundgaraba/effect-actions";

const rootImport = await import(packageRoot).then(
  () => "resolved",
  () => "absent",
);

if (rootImport !== "absent") throw new Error("The package root must not be an entry point");

const checkTypes = (client: HttpApiClient.ForApi<typeof Http.api>) => {
  // @ts-expect-error Published declarations must reject incorrect input.
  client.greetings.greet({ payload: { name: 123 } });

  // @ts-expect-error Published declarations must retain the result type.
  const wrong: Effect.Effect<number, unknown, unknown> = client.greetings.greet({
    payload: { name: "Ada" },
  });

  return wrong;
};

void checkTypes;

const web = HttpRouter.toWebHandler(routes.pipe(Layer.provide(HttpServer.layerServices)), {
  disableLogger: true,
});

try {
  const response = await web.handler(
    mcpRequest({ method: "tools/list", url: "http://localhost/mcp" }),
  );

  if (response.status !== 200)
    throw new Error("Stateless MCP request failed without the optional client peer");

  const greeting = await Effect.gen(function* () {
    const client = yield* httpClient(Http.api, web.handler);

    return yield* client.greetings.greet({ payload: { name: "Ada" } });
  }).pipe(Effect.runPromise);

  if (greeting !== "Hello, Ada!") throw new Error(`Unexpected greeting: ${greeting}`);
} finally {
  await web.dispose();
}

const discovery = Authentication.protectedResource({
  resource: "https://example.com/mcp",
  authorizationServers: ["https://example.com/auth"],
});

if (!discovery.challenge().includes(discovery.metadataUrl))
  throw new Error("Missing discovery challenge");

const catalog = ActionCatalog.make(Actions);

if (catalog.actions[0]?.id !== "greetings.greet") throw new Error("Catalog projection failed");

const app = Actions.implement({
  greet: ({ name }) => Effect.succeed(`Hello, ${name}!`),
});

const binding = ActionToolkit.make(app);

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

const localCommand = ActionCli.group(app);

if (localCommand.name !== "greetings") throw new Error("Local CLI projection failed");

const remoteCommand = ActionCliClient.group(Http, "greetings");

if (remoteCommand.name !== "greetings") throw new Error("Remote CLI projection failed");

const configuredCommand = ActionCli.command(app, "greet", {
  parameters: { name: Argument.String("name") },
  input: ({ name }) => ({ name }),
  render: (greeting) => greeting.toUpperCase(),
});

if (configuredCommand.name !== "greet") throw new Error("Configured CLI projection failed");

const configuredRemote = ActionCliClient.command(Http, "greetings", "greet", {
  parameters: { name: Argument.String("name") },
  input: ({ name }) => ({ name }),
  render: (greeting) => greeting.toUpperCase(),
});

if (configuredRemote.name !== "greet") throw new Error("Configured remote CLI projection failed");

const checkCliTypes = () => {
  // @ts-expect-error Remote selectors accept binding-owned names, not another contract.
  ActionCliClient.command(Http, Actions, "greet");
  // @ts-expect-error Names are constrained to the selected HTTP binding.
  ActionCliClient.command(Http, "missing", "greet");
};

void checkCliTypes;
