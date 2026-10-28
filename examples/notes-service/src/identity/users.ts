import { scopes } from "./Identity.js";
import type { User } from "./Identity.js";

export const demoUsers = {
  ada: { id: "ada", scopes: [scopes.read, scopes.write] },
  grace: { id: "grace", scopes: [scopes.read, scopes.write] },
  reader: { id: "reader", scopes: [scopes.read] },
} as const satisfies Readonly<Record<string, User>>;
