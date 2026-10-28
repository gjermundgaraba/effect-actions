import { scopes } from "./Identity.js";
import type { Member } from "./Identity.js";

export const demoMembers = {
  ada: { id: "ada", workspace: "acme", scopes: [scopes.read, scopes.write] },
  adaAtGlobex: { id: "ada", workspace: "globex", scopes: [scopes.read] },
  linus: { id: "linus", workspace: "acme", scopes: [scopes.read] },
  kay: { id: "kay", workspace: "acme", scopes: [] },
  grace: {
    id: "grace",
    workspace: "globex",
    scopes: [scopes.read, scopes.write],
  },
} as const satisfies Readonly<Record<string, Member>>;
