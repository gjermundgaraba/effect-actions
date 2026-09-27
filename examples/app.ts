import { Layer } from "effect";
import { layer as http } from "./http.js";
import { layer as mcp } from "./mcp.js";
import { requestPolicy } from "./request-policy.js";
import { Users } from "./users.js";

// Every surface of one host. Each builder runs once, however many of these layers
// serve its implementation.
export const layer = Layer.mergeAll(http, mcp).pipe(
  Layer.provide(requestPolicy.layer),
  Layer.provide(Users.layerMemory),
);
