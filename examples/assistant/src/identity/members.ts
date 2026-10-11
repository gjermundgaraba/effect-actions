import type { Member } from "./Identity.js";

// DEMO ONLY: the team, by name. A real host maps the user its chat platform has verified to a
// `Member`. Typed as members alone: no entry, and so no sign-in, can be the operator.
export const members = {
  ada: { kind: "member", id: "ada" },
  grace: { kind: "member", id: "grace" },
  guest: { kind: "member", id: "guest" },
} as const satisfies Readonly<Record<string, Member>>;
