import type { KeyOperator } from "./Admin.js";

// DEMO ONLY: two fixed operator keys. A real application has no such table: it stores a hash
// of each key it issued, and looks the operator up by it.
export const keys = new Map<string, KeyOperator>([
  ["ops-key", { id: "ops", trusted: false }],
  ["support-key", { id: "support", trusted: false }],
]);
