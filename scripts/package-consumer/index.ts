import * as Action from "@gjermundgaraba/effect-actions/Action";
import * as ActionGroup from "@gjermundgaraba/effect-actions/ActionGroup";
import * as ActionHttp from "@gjermundgaraba/effect-actions/ActionHttp";
import * as Authentication from "@gjermundgaraba/effect-actions/Authentication";
import * as ActionMcp from "@gjermundgaraba/effect-actions/ActionMcp";
import { httpClient, mcpRequest } from "@gjermundgaraba/effect-actions/Testing";
import { Effect, Layer } from "effect";
import { HttpRouter, HttpServer } from "effect/unstable/http";
import { type Actions, Http, routes } from "./quickstart.js";

const entries = [
  Action.make,
  ActionGroup.make,
  ActionHttp.make,
  ActionMcp.layer,
  Authentication.middleware,
];

if (!entries.every((entry) => entry instanceof Function))
  throw new Error("A subpath entry point did not load");

// Subpaths are the only entry points: one module each, so nothing loads the MCP
// server or the optional client peer by accident.
const packageRoot: string = "@gjermundgaraba/effect-actions";

const rootImport = await import(packageRoot).then(
  () => "resolved",
  () => "absent",
);

if (rootImport !== "absent") throw new Error("The package root must not be an entry point");

const checkTypes = (client: ActionHttp.Client<typeof Actions>) => {
  // @ts-expect-error Published declarations must reject incorrect input.
  client.greet({ name: 123 });
  // @ts-expect-error Published declarations must retain the result type.
  const wrong: Effect.Effect<number, unknown, unknown> = client.greet({ name: "Ada" });

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
    const client = yield* httpClient(Http, web.handler);

    return yield* client.greet({ name: "Ada" });
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
