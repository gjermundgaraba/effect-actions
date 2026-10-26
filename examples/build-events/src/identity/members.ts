import type { Member } from "./Identity.js";

// DEMO ONLY: the members who may sign in, each under a token that is their name.
export const members = {
  ada: { id: "ada", pipelines: ["api", "web"] },
  grace: { id: "grace", pipelines: ["web"] },
} as const satisfies Readonly<Record<string, Member>>;
