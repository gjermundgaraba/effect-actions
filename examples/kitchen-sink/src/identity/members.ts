import { scopes } from "./Identity.js";
import type { Member } from "./Identity.js";

// DEMO ONLY: the people of the demo, each a member of one workspace. A real application has no
// such table: its directory reads a member from a signed token or a stored session. A local
// host names its caller with one of these, and so does a test.
export const members = {
  ada: { id: "ada", workspace: "acme", scopes: [scopes.read, scopes.write] },
  adaAtGlobex: { id: "ada", workspace: "globex", scopes: [scopes.read] },
  linus: { id: "linus", workspace: "acme", scopes: [scopes.read] },
  // Invited to acme, granted nothing yet.
  kay: { id: "kay", workspace: "acme", scopes: [] },
  grace: {
    id: "grace",
    workspace: "globex",
    scopes: [scopes.read, scopes.write],
  },
} as const satisfies Readonly<Record<string, Member>>;
