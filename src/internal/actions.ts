import type * as Action from "../Action.js";

/**
 * An action's own failures plus the ones its surface answers with, which is what
 * a projection of that action declares. A schema the action already declares is
 * not repeated.
 */
export const projectedErrors = (
  action: Action.Any,
  surface: Action.Any["errors"],
): Action.Any["errors"] => [...new Set([...action.errors, ...surface])];

const validName = /^[A-Za-z0-9_-]{1,128}$/;

/** Names become path segments, OpenAPI identifiers and client method keys. */
export const assertName = (what: string, name: string): void => {
  if (!validName.test(name) || name === "then") throw new Error(`Invalid ${what}: ${name}`);
};

/**
 * Names are checked by whoever owns them: an implementation, a binding, a CLI, or the MCP
 * tools. `claimantOf` says who claims a name, so a clash between two claimants names both.
 */
export const assertDistinct = <T>(
  what: string,
  items: ReadonlyArray<T>,
  nameOf: (item: T) => string,
  claimantOf: (item: T) => string = nameOf,
): void => {
  const seen = new Map<string, string>();

  for (const item of items) {
    const name = nameOf(item);
    const claimant = claimantOf(item);
    const other = seen.get(name);

    if (other !== undefined) {
      const by = other === claimant ? "" : `, claimed by ${other} and ${claimant}`;

      throw new Error(`Duplicate ${what}: ${name}${by}`);
    }

    seen.set(name, claimant);
  }
};
