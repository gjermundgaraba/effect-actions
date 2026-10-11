import { Effect, Layer } from "effect";
import { HttpRouter, HttpServerResponse } from "effect/http";
import { HttpApiSwagger, OpenApi } from "effect/http-api";
import { RpcSerialization, RpcServer } from "effect/rpc";
import * as Action from "@gjermundgaraba/effect-actions/Action";
import * as ActionHttp from "@gjermundgaraba/effect-actions/ActionHttp";
import * as ActionMcp from "@gjermundgaraba/effect-actions/ActionMcp";
import * as ActionRpc from "@gjermundgaraba/effect-actions/ActionRpc";
import { MemberActions, Tools } from "./Actions.js";
import { authenticateOperator } from "./admin/authenticate.js";
import { assistant } from "./assistant/handlers.js";
import { admin } from "./admin/handlers.js";
import { AdminHttp, Http } from "./Api.js";
import { download } from "./attachments/download.js";
import { attachments } from "./attachments/handlers.js";
import { allowedOrigins } from "./config.js";
import { authenticateBearer, authenticateSession } from "./identity/authenticate.js";
import { identity } from "./identity/handlers.js";
import { Login } from "./identity/Identity.js";
import { HttpQuota, quota, RpcQuota } from "./identity/quota.js";
import { layer as assistantTools } from "./issues/assistant.js";
import { features } from "./issues/guide.js";
import { issues } from "./issues/handlers.js";
import { cors, requestPolicy } from "./request-policy.js";
import { Rpc } from "./Rpc.js";
import { status } from "./workspaces/handlers.js";
import { resolveTenant } from "./workspaces/tenant.js";
import { GetStatus } from "./workspaces/Workspaces.js";

// Every domain's implementation of the public port's actions, once. Each surface below takes
// this one list and serves the actions its binding or its `actions` names.
const implementations = [status, identity, issues, attachments, assistant];

// JSON routes at `/api/v1/<action>`, in two layers of one binding, each naming its `actions`.
// The quota requires the caller, and a public route has none, so `getStatus` is served by a
// layer without it. The middleware runs inside authentication and before the input is decoded.
const api = Layer.mergeAll(
  ActionHttp.layer(Http, implementations, { actions: [GetStatus] }),
  ActionHttp.layer(Http, implementations, { actions: MemberActions, middleware: [HttpQuota] }),
);

// The same actions as MCP tools at `/mcp`: a mixed endpoint. Listing the tools and calling
// `getStatus` need no token; any other request answers the 401 an MCP client signs in on, the
// one opening a session included, since a session may call any tool.
const mcp = Layer.unwrap(
  Effect.map(allowedOrigins, (origins) =>
    ActionMcp.layerHttp(implementations, {
      name: "tracker",
      version: "1.0.0",
      instructions: "Read an issue before commenting on it or closing it.",
      authentication: Login,
      actions: Tools,
      features,
      // The endpoint's own Origin allowlist, narrower than the request policy, which has
      // already refused a foreign Origin: that policy also lets through a page of any name
      // this host answers to, such as http://127.0.0.1:3000. Not listed here, such a page gets
      // a 403 from the endpoint.
      allowedOrigins: origins,
    }),
  ),
);

// The members' actions as Effect RPC, for the web app, behind its session cookie and the same
// quota as native RPC middleware. It still requires its protocol: the server gives it a
// WebSocket, and a test Effect's HTTP protocol, which answers in memory.
export const rpc = ActionRpc.layer(Rpc, implementations, { middleware: [RpcQuota] }).pipe(
  Layer.provide([authenticateSession, quota, assistantTools]),
);

const socket = rpc.pipe(
  Layer.provide(RpcServer.layerProtocolWebsocket({ path: "/rpc" })),
  Layer.provide(RpcSerialization.layerJson),
);

// Effect's own tools read the binding's native `HttpApi`: the OpenAPI document and a Swagger
// UI, each showing the bearer scheme on every route but `getStatus`.
const documentation = Layer.mergeAll(
  HttpRouter.add(
    "GET",
    `${Http.prefix}/openapi.json`,
    HttpServerResponse.jsonUnsafe(OpenApi.fromApi(Http.api)),
  ),
  HttpApiSwagger.layer(Http.api, { path: "/docs" }),
);

const health = HttpRouter.add("GET", "/healthz", HttpServerResponse.text("ok"));

// The public port: what members reach. Each `Layer.provide` gives what the layers before it
// still owe, and is built before them. Two things follow from that order.
//
// - `resolveTenant`, in a `Layer.provide` of its own after the authentication, gives the
//   `Tenant` the Bearer verifier reads per request. In one array with `authenticateBearer` it
//   would leave `Tenant` owed: an array's members provide to the routes, not to one another.
// - Global middleware runs in the order it registers, and it registers when its layer is
//   built. The request policy, provided last, is built first, so it runs before everything:
//   before CORS, and before the OAuth discovery the Bearer provider registers when it is
//   built. Merged beside the routes instead, it would register after that provider, and a
//   foreign Host could read the discovery document.
//
// The assistant's builder yields its tools, so their handlers are provided to the layers
// serving it, here and on `rpc`: one Layer, built once in the routes' layer graph, where the
// tools run the issue implementation the routes serve, with no second build of it.
export const publicRoutes = Layer.mergeAll(api, mcp, socket, download, documentation, health).pipe(
  Layer.provide(assistantTools),
  Layer.provide([authenticateBearer, authenticateSession, quota]),
  Layer.provide(resolveTenant.layer),
  Layer.provide(cors),
  Layer.provide(requestPolicy),
);

// The admin port: what operators reach, and nothing else. It is a router of its own, with its
// own binding, descriptor and provider, so no member's token is even understood here. It
// serves one implementation the public port serves too, `status`.
export const adminRoutes = Layer.mergeAll(
  ActionHttp.layer(AdminHttp, [status, admin]),
  health,
).pipe(Layer.provide(authenticateOperator), Layer.provide(requestPolicy));

// Every builder as one layer. The two ports are two layer graphs, and each would run the
// builder of an implementation it serves: `status`, which both serve, twice, each port then
// reporting an `instance` of its own. Provided above both, with the services, each builder
// runs once for every surface of both ports. The assistant's is left out: the public port
// alone serves it, and builds it once for its routes and its rpcs.
export const builders = Action.layer([status, identity, issues, attachments, admin]);
