import * as ActionHttp from "@gjermundgaraba/effect-actions/ActionHttp";
import * as ActionMcp from "@gjermundgaraba/effect-actions/ActionMcp";
import * as ActionRpc from "@gjermundgaraba/effect-actions/ActionRpc";
import * as Webhook from "@gjermundgaraba/effect-actions/Webhook";
import { Layer } from "effect";
import { RpcSerialization, RpcServer } from "effect/rpc";

import { Http } from "./Api.js";
import { buildEvents } from "./builds/events.js";
import { builds } from "./builds/handlers.js";
import { logs } from "./builds/log.js";
import { statusEvents } from "./builds/status.js";
import { deployEvents } from "./deploys/events.js";
import { deploys } from "./deploys/handlers.js";
import { Login } from "./identity/Identity.js";
import { authenticate } from "./identity/verifier.js";
import { Rpc } from "./Rpc.js";

const implementations = [
  builds,
  logs,
  buildEvents,
  statusEvents,
  deploys,
  deployEvents,
];

const mcp = ActionMcp.layerHttp(
  [builds, buildEvents, statusEvents, deploys, deployEvents],
  {
    name: "build-events",
    version: "1.0.0",
    authentication: Login,
  }
);

const api = ActionHttp.layer(Http, implementations);

const rpc = ActionRpc.layer(Rpc, implementations).pipe(
  Layer.provide(RpcServer.layerProtocolHttp({ path: "/rpc" })),
  Layer.provide(RpcSerialization.layerNdjson)
);

export const routes = Layer.mergeAll(mcp, api, rpc).pipe(
  Layer.provide(authenticate),
  Layer.provide(Webhook.layer({ persist: true }))
);
