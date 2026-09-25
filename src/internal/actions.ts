import type * as Action from "../Action.js";

/**
 * An action's own failures plus the ones its surface answers with, which is what
 * a projection of that action declares. A schema the action already declares is
 * not repeated.
 */
export const projectedErrors = (
  action: Action.Any,
  surface: ReadonlyArray<Action.Codec>,
): ReadonlyArray<Action.Codec> => [...new Set([...action.errors, ...surface])];

const validName = /^[A-Za-z0-9_-]{1,128}$/;

/** Names become path segments, OpenAPI identifiers and client method keys. */
export const assertName = (what: string, name: string): void => {
  if (!validName.test(name) || name === "then") throw new Error(`Invalid ${what}: ${name}`);
};

/** Names are checked by whoever owns them: an implementation, a binding, a CLI, or the MCP tools. */
export const assertDistinct = (what: string, names: ReadonlyArray<string>): void => {
  const seen = new Set<string>();

  for (const name of names) {
    if (seen.has(name)) throw new Error(`Duplicate ${what}: ${name}`);
    seen.add(name);
  }
};
