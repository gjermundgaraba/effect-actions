import * as ActionsPackage from "@gjermundgaraba/effect-actions";
import * as Action from "@gjermundgaraba/effect-actions/Action";
import * as ActionGroup from "@gjermundgaraba/effect-actions/ActionGroup";
import * as ActionHttp from "@gjermundgaraba/effect-actions/http";
import * as Authentication from "@gjermundgaraba/effect-actions/authentication";
import * as ActionMcp from "@gjermundgaraba/effect-actions/mcp";
import { mcpRequest } from "@gjermundgaraba/effect-actions/testing";
import { Effect, Layer } from "effect";
import { FetchHttpClient, HttpRouter, HttpServer } from "effect/unstable/http";
import { Actions, routes } from "./quickstart.js";

if (
  ActionsPackage.Action.make !== Action.make ||
  ActionsPackage.ActionGroup.make !== ActionGroup.make ||
  ActionsPackage.ActionHttp.layer !== ActionHttp.layer ||
  ActionsPackage.ActionMcp.layer !== ActionMcp.layer ||
  ActionsPackage.Authentication.middleware !== Authentication.middleware
) {
  throw new Error("Root and subpath exports disagree");
}

const checkTypes = (client: ActionHttp.Client<typeof Actions.actions>) => {
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
  const response = await web.handler(mcpRequest("tools/list"));
  if (response.status !== 200)
    throw new Error("Stateless MCP request failed without the optional client peer");
  const greeting = await Effect.gen(function* () {
    const client = yield* ActionHttp.client(Actions, { baseUrl: "http://localhost" });
    return yield* client.greet({ name: "Ada" });
  }).pipe(
    Effect.provide(FetchHttpClient.layer),
    Effect.provideService(FetchHttpClient.Fetch, (input, init) =>
      web.handler(new Request(input, init)),
    ),
    Effect.runPromise,
  );
  if (greeting !== "Hello, Ada!") throw new Error(`Unexpected greeting: ${greeting}`);
} finally {
  await web.dispose();
}

const discovery = ActionMcp.protectedResource({
  resource: "https://example.com/mcp",
  authorizationServers: ["https://example.com/auth"],
});
if (!discovery.challenge().includes(discovery.metadataUrl))
  throw new Error("Missing discovery challenge");
