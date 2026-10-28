import type { Member } from "./Identity.js";

export const demoMembers = {
  ada: { kind: "member", id: "ada" },
  grace: { kind: "member", id: "grace" },
  guest: { kind: "member", id: "guest" },
} as const satisfies Readonly<Record<string, Member>>;
