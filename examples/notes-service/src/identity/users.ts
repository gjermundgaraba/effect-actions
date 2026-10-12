import { scopes, type User } from "./Identity.js";

// DEMO ONLY: the people who may sign in, each under a token that is their name. A real service
// has no such table: its verifier reads the user from a signed token.
export const users = {
  ada: { id: "ada", scopes: [scopes.read, scopes.write] },
  grace: { id: "grace", scopes: [scopes.read, scopes.write] },
  reader: { id: "reader", scopes: [scopes.read] },
} as const satisfies Readonly<Record<string, User>>;
