import type { Member } from "./Identity.js";

export const demoMembers = {
  ada: { id: "ada", pipelines: ["api", "web"] },
  grace: { id: "grace", pipelines: ["web"] },
} as const satisfies Readonly<Record<string, Member>>;
