import type { Member } from "./Identity.js";

export const demoMembers = {
  ada: { id: "ada", rooms: ["general", "design"] },
  grace: { id: "grace", rooms: ["general"] },
} satisfies Record<string, Member>;
