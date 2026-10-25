import { Layer } from "effect";
import { RpcSerialization, RpcServer } from "effect/rpc";
import * as ActionHttp from "@gjermundgaraba/effect-actions/ActionHttp";
import * as ActionMcp from "@gjermundgaraba/effect-actions/ActionMcp";
import * as ActionRpc from "@gjermundgaraba/effect-actions/ActionRpc";
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

// Every domain's implementation, once: the events beside the actions, in one list.
const implementations = [builds, logs, buildEvents, statusEvents, deploys, deployEvents];

// The actions as MCP tools and the events as MCP events, at `/mcp`. A client polls with
// `events/poll`, or holds `events/stream` open and is pushed each occurrence. Both events are
// protected, so each request needs a member's token, and each subscriber sees what its token
// lets it. One server holds the deploy event's `subscription` hook between requests, and its log
// in memory, so this endpoint cannot be `requestScoped`; a serverless host would serve check
// sources by poll alone.
//
// A tool answers one result, so `tailLog` would collect a whole log before answering, all of it
// in a model's context: its implementation, `logs`, is left out, and the endpoint serves every
// other action and every event.
const mcp = ActionMcp.layerHttp([builds, buildEvents, statusEvents, deploys, deployEvents], {
  name: "build-events",
  version: "1.0.0",
  authentication: Login,
});

// The same implementations as routes under `/api`, for a client that speaks HTTP rather than
// MCP: one implementation of each event serves every surface.
const api = ActionHttp.layer(Http, implementations);

// And as Effect RPC at `/rpc`, over HTTP. A watch is a stream rpc that never ends, so the
// serialization frames each element as it is sent: `layerNdjson` does, where `layerJson` would
// answer once every stream of the request ended, which a watch never does.
const rpc = ActionRpc.layer(Rpc, implementations).pipe(
  Layer.provide(RpcServer.layerProtocolHttp({ path: "/rpc" })),
  Layer.provide(RpcSerialization.layerNdjson),
);

export const routes = Layer.mergeAll(mcp, api, rpc).pipe(Layer.provide(authenticate));
