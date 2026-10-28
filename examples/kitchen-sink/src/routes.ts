import * as Action from "@gjermundgaraba/effect-actions/Action";
import * as ActionHttp from "@gjermundgaraba/effect-actions/ActionHttp";
import * as ActionMcp from "@gjermundgaraba/effect-actions/ActionMcp";
import * as ActionRpc from "@gjermundgaraba/effect-actions/ActionRpc";
import * as Webhook from "@gjermundgaraba/effect-actions/Webhook";
import { Effect, Layer } from "effect";
import { HttpRouter, HttpServerResponse } from "effect/http";
import { HttpApiSwagger, OpenApi } from "effect/http-api";

import { MemberActions, Tools } from "./Actions.js";
import { authenticateOperator } from "./admin/authenticate.js";
import { admin } from "./admin/handlers.js";
import { AdminHttp, Http } from "./Api.js";
import { assistant } from "./assistant/handlers.js";
import { download } from "./attachments/download.js";
import { attachments } from "./attachments/handlers.js";
import { allowedOrigins } from "./config.js";
import {
  authenticateBearer,
  authenticateSession,
} from "./identity/authenticate.js";
import { identity } from "./identity/handlers.js";
import { Login } from "./identity/Identity.js";
import { HttpQuota, quota, RpcQuota } from "./identity/quota.js";
import { layer as assistantTools } from "./issues/assistant.js";
import { issueEvents } from "./issues/events.js";
import { exports } from "./issues/export.js";
import { features } from "./issues/guide.js";
import { issues } from "./issues/handlers.js";
import { IssueChanged } from "./issues/Issues.js";
import { cors, requestPolicy } from "./request-policy.js";
import { Rpc } from "./Rpc.js";
import { status } from "./workspaces/handlers.js";
import { resolveTenant } from "./workspaces/tenant.js";
import { GetStatus } from "./workspaces/Workspaces.js";

const implementations = [
  status,
  identity,
  issues,
  issueEvents,
  exports,
  attachments,
  assistant,
];

const api = Layer.mergeAll(
  ActionHttp.layer(Http, implementations, { actions: [GetStatus] }),
  ActionHttp.layer(Http, implementations, {
    actions: [...MemberActions, IssueChanged],
    middleware: [HttpQuota],
  })
);

const mcp = Layer.unwrap(
  Effect.map(allowedOrigins, (origins) =>
    ActionMcp.layerHttp(implementations, {
      name: "tracker",
      version: "1.0.0",
      instructions: "Read an issue before commenting on it or closing it.",
      authentication: Login,
      actions: [...Tools, IssueChanged],
      features,
      allowedOrigins: origins,
    })
  )
);

export const rpc = ActionRpc.layer(Rpc, implementations, {
  middleware: [RpcQuota],
}).pipe(Layer.provide([authenticateSession, quota, assistantTools]));

const documentation = Layer.mergeAll(
  HttpRouter.add(
    "GET",
    `${Http.prefix}/openapi.json`,
    HttpServerResponse.jsonUnsafe(OpenApi.fromApi(Http.api))
  ),
  HttpApiSwagger.layer(Http.api, { path: "/docs" })
);

const health = HttpRouter.add("GET", "/healthz", HttpServerResponse.text("ok"));

export const publicRoutes = Layer.mergeAll(
  api,
  mcp,
  download,
  documentation,
  health
).pipe(
  Layer.provide(Webhook.layer()),
  Layer.provide(assistantTools),
  Layer.provide([authenticateBearer, authenticateSession, quota]),
  Layer.provide(resolveTenant.layer),
  Layer.provide(cors),
  Layer.provide(requestPolicy)
);

export const adminRoutes = Layer.mergeAll(
  ActionHttp.layer(AdminHttp, [status, admin]),
  health
).pipe(Layer.provide(authenticateOperator), Layer.provide(requestPolicy));

export const builders = Action.layer([
  status,
  identity,
  issues,
  attachments,
  admin,
]);
