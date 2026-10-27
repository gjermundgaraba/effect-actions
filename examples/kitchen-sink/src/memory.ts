import * as Event from "@gjermundgaraba/effect-actions/Event";
import { Layer } from "effect";
import { RateLimiter } from "effect/persistence";

import { Grants } from "./admin/grants.js";
import { Conversations } from "./assistant/conversations.js";
import { demoModel } from "./assistant/demo-model.js";
import { AttachmentStore } from "./attachments/store.js";
import { Directory } from "./identity/directory.js";
import { IssueStore } from "./issues/store.js";
import { WorkspaceRegistry } from "./workspaces/registry.js";

// DEMO ONLY: the application's services as their memory or fixed-data Layers, lost when the
// process stops. A real entrypoint provides a database-backed Layer per service instead, and a
// test replaces the one it is about.

/** Both stores. The attachment store is built on the issue store: `provideMerge` keeps it. */
export const stores = AttachmentStore.layerMemory.pipe(
  Layer.provideMerge(IssueStore.layerMemory)
);

/** Effect's own limiter, counting in memory. `RateLimiter.layerStoreRedis` counts across processes. */
export const limiter = RateLimiter.layer.pipe(
  Layer.provide(RateLimiter.layerStoreMemory)
);

/** Everything the server needs, for both ports. A local entrypoint provides only what it serves. */
export const memory = Layer.mergeAll(
  stores,
  limiter,
  WorkspaceRegistry.layerMemory,
  Directory.layerDemo,
  Grants.layerDemo,
  Conversations.layerMemory,
  demoModel,
  // The issue changes' log, kept in this process for the subscribers its sockets and streams
  // hold.
  Event.layerMemory
);
