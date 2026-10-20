import type * as Action from "./Action.js";

const namePattern = "[A-Za-z0-9_-]{1,128}";

const validName = new RegExp(`^${namePattern}$`);

export const assertName = (name: string): void => {
  if (!validName.test(name) || name === "then") {
    throw new Error(`Invalid action name: ${name} (use ${namePattern}, other than "then")`);
  }
};

export const assertDistinct = <T>(
  what: string,
  items: ReadonlyArray<T>,
  nameOf: (item: T) => string,
  { claimantOf = nameOf, fix }: { readonly claimantOf?: (item: T) => string; readonly fix: string },
): void => {
  const seen = new Map<string, string>();

  for (const item of items) {
    const name = nameOf(item);
    const claimant = claimantOf(item);
    const other = seen.get(name);

    if (other !== undefined) {
      const by = other === claimant ? "" : `, claimed by ${other} and ${claimant}`;

      throw new Error(`Duplicate ${what}: ${name}${by} (${fix})`);
    }

    seen.set(name, claimant);
  }
};

export const assertOnce = (what: string, actions: ReadonlyArray<Action.Any>): void =>
  assertDistinct(what, actions, (action) => action.name, { fix: "list it once, or rename one" });

export const assertKnown = (
  what: string,
  keys: ReadonlyArray<string>,
  names: ReadonlyArray<string>,
  fix: string,
): void => {
  const unknown = keys.filter((key) => !names.includes(key));

  if (unknown.length > 0) throw new Error(`Unknown ${what}: ${unknown.join(", ")} (${fix})`);
};
