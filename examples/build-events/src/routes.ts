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

// Every domain's implementation, once: the events beside the actions, in one list.
const implementations = [
  builds,
  logs,
  buildEvents,
  statusEvents,
  deploys,
  deployEvents,
];

// The actions as MCP tools and the events as MCP events, at `/mcp`. A client polls with
// `events/poll`, or holds `events/stream` open and is pushed each occurrence. Both events are
// protected, so each request needs a member's token, and each subscriber sees what its token
// lets it. This long-lived process holds the deploy event's `subscription` hook between polls and
// its log in memory, and pushes each occurrence: a `requestScoped` endpoint would serve the events
// by poll and webhook alone, and a serverless host, where no process lasts, check sources alone,
// without `Webhook.layer`.
//
// A tool answers one result, so `tailLog` would collect a whole log before answering, all of it
// in a model's context: its implementation, `logs`, is left out, and the endpoint serves every
// other action and every event.
const mcp = ActionMcp.layerHttp(
  [builds, buildEvents, statusEvents, deploys, deployEvents],
  {
    name: "build-events",
    version: "1.0.0",
    authentication: Login,
  }
);

// The same implementations as routes under `/api`, for a client that speaks HTTP rather than
// MCP: one implementation of each event serves every surface.
const api = ActionHttp.layer(Http, implementations);

// And as Effect RPC at `/rpc`, over HTTP. A watch is a stream rpc that never ends, so the
// serialization frames each element as it is sent: `layerNdjson` does, where `layerJson` would
// answer once every stream of the request ended, which a watch never does.
const rpc = ActionRpc.layer(Rpc, implementations).pipe(
  Layer.provide(RpcServer.layerProtocolHttp({ path: "/rpc" })),
  Layer.provide(RpcSerialization.layerNdjson)
);

// Webhook delivery for MCP and HTTP alike: a member names a callback URL and a secret, with
// MCP's `events/subscribe` or `POST /api/events/<name>/subscribe`, and each occurrence it may see
// is POSTed there, signed. One layer holds the subscriptions of both, so either surface refreshes
// one made over the other. `persist` keeps each in a `KeyValueStore`, so a restart goes on
// delivering from where it reached, as the subscriber `Login`'s `schema` keeps. It needs an
// `HttpClient` to POST, `Dns` to check where each callback resolves, and the store, which
// `server.ts` provides.
export const routes = Layer.mergeAll(mcp, api, rpc).pipe(
  Layer.provide(authenticate),
  Layer.provide(Webhook.layer({ persist: true }))
);
