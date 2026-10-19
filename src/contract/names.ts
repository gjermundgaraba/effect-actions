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

export const assertOnce = (what: string, actions: ReadonlyArray<Action.Any>): void => {
  const seen = new Map<string, Action.Any>();

  for (const action of actions) {
    const other = seen.get(action.name);

    if (other !== undefined) {
      throw new Error(
        other === action
          ? `Duplicate ${what}: ${action.name}, listed twice (list it once; of two implementations of one contract, pass one)`
          : `Duplicate ${what}: ${action.name}, two share the name (rename one)`,
      );
    }

    seen.set(action.name, action);
  }
};
