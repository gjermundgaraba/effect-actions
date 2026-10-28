import type { KeyOperator } from "./Admin.js";

export const demoOperatorKeys = new Map<string, KeyOperator>([
  ["ops-key", { id: "ops", trusted: false }],
  ["support-key", { id: "support", trusted: false }],
]);
