import type { Member } from "./Identity.js";

// DEMO ONLY: the members, and the pipelines each may see.
export const members = {
  ada: { id: "ada", pipelines: ["api", "web"] },
  grace: { id: "grace", pipelines: ["web"] },
} as const satisfies Readonly<Record<string, Member>>;
