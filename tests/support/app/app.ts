import { Layer } from "effect";
import { layer as http } from "./http.js";
import { layer as mcp } from "./mcp.js";
import { requestPolicy } from "./request-policy.js";
import { Users } from "./users.js";

export const layer = Layer.mergeAll(requestPolicy, http, mcp).pipe(
  Layer.provide(Users.layerMemory),
);
