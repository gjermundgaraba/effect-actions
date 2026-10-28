import type { Member } from "./Identity.js";

export const demoMembers = {
  ada: { id: "ada", rooms: ["lobby", "ops"] },
  grace: { id: "grace", rooms: ["lobby"] },
} as const satisfies Readonly<Record<string, Member>>;
