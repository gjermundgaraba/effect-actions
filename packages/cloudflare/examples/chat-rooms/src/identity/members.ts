import type { Member } from "./Identity.js";

// DEMO ONLY: fixed members, each token their name. A real application keeps members in its
// identity provider and their rooms in a store.
export const members = {
  ada: { id: "ada", rooms: ["lobby", "design"] },
  grace: { id: "grace", rooms: ["lobby"] },
} satisfies Record<string, Member>;
