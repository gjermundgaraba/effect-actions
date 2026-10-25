import type * as Action from "./Action.js";

const namePattern = "[A-Za-z0-9_-]{1,128}";

const validName = new RegExp(`^${namePattern}$`);

// Why: Every client is keyed by action name, so a name a client already answers to would
// shadow it.
const reserved = [
  ["then", "which would make a client a thenable, awaited as a promise"],
  ["watch", "every client's method for events"],
] as const;

export const reservedNames: ReadonlyArray<string> = reserved.map(([name]) => name);

export const assertName = (name: string): void => {
  if (!validName.test(name) || reservedNames.includes(name)) {
    throw new Error(
      `Invalid action name: ${name} (use ${namePattern}, other than ${reserved
        .map(([reservedName, why]) => `"${reservedName}", ${why}`)
        .join(", and ")})`,
    );
  }
};

export const assertDistinct = <T>(
  what: string,
  items: ReadonlyArray<T>,
  nameOf: (item: T) => string,
  {
    claimantOf = nameOf,
    labelOf = nameOf,
    fix,
  }: {
    readonly claimantOf?: (item: T) => string;
    readonly labelOf?: (item: T) => string;
    readonly fix: string;
  },
): void => {
  const seen = new Map<string, T>();

  for (const item of items) {
    const name = nameOf(item);
    const other = seen.get(name);

    if (other !== undefined) {
      const claimants = [claimantOf(other), claimantOf(item)];
      const by = claimants[0] === claimants[1] ? "" : `, claimed by ${claimants.join(" and ")}`;

      throw new Error(`Duplicate ${what}: ${labelOf(other)}${by} (${fix})`);
    }

    seen.set(name, item);
  }
};

export const heldOnce = "pass one implementation of it, or rename one";

export const assertOnce = (
  what: string,
  actions: ReadonlyArray<Pick<Action.Any, "name">>,
  fix: string = "list it once, or rename one",
): void => assertDistinct(what, actions, (action) => action.name, { fix });

export const assertKnown = (
  what: string,
  keys: ReadonlyArray<string>,
  names: ReadonlyArray<string>,
  fix: string,
): void => {
  const unknown = keys.filter((key) => !names.includes(key));

  if (unknown.length > 0) throw new Error(`Unknown ${what}: ${unknown.join(", ")} (${fix})`);
};
