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

export const stores = AttachmentStore.layerMemory.pipe(
  Layer.provideMerge(IssueStore.layerMemory)
);

export const limiter = RateLimiter.layer.pipe(
  Layer.provide(RateLimiter.layerStoreMemory)
);

export const memory = Layer.mergeAll(
  stores,
  limiter,
  WorkspaceRegistry.layerMemory,
  Directory.layerDemo,
  Grants.layerDemo,
  Conversations.layerMemory,
  demoModel,
  Event.layerMemory
);
