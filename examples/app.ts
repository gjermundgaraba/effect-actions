import { Layer } from "effect";
import { layer as http } from "./http.js";
import { layer as mcp } from "./mcp.js";
import { requestPolicy } from "./request-policy.js";
import { Users } from "./users.js";

// Every surface of one host, behind its request policy: merged first, beside the routes, so
// it runs before the discovery the authentication publishes too. Each builder runs once,
// however many of these layers serve its implementation.
export const layer = Layer.mergeAll(requestPolicy, http, mcp).pipe(
  Layer.provide(Users.layerMemory),
);
