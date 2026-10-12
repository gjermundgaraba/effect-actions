import type { Member } from "./Identity.js";

// DEMO ONLY: the people who may sign in, each under a token that is their name. A real service
// has no such table: its verifier reads the member from a signed token.
export const members = {
  ada: { id: "ada", rooms: ["lobby", "ops"] },
  grace: { id: "grace", rooms: ["lobby"] },
} as const satisfies Readonly<Record<string, Member>>;
