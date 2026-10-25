import { Layer } from "effect";
import * as Event from "@gjermundgaraba/effect-actions/Event";
import { BuildStore } from "../../src/builds/store.js";
import { Approvers } from "../../src/deploys/approvers.js";

// What the routes need, in memory: the stores and the events announced.
export const inMemory = Layer.mergeAll(
  BuildStore.layerMemory,
  Approvers.layerMemory,
  Event.layerMemory,
);
