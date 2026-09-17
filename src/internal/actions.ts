import type * as Action from "../Action.js";

/** The contract half of a group: what adapters and clients need, without `implement`. */
export interface Actions<
  Name extends string = string,
  A extends ReadonlyArray<Action.Any> = ReadonlyArray<Action.Any>,
> {
  readonly name: Name;
  readonly actions: A;
}

/** Each namespace is checked by whoever owns it: a group, the routes, or the MCP tools. */
export const assertDistinct = (what: string, names: ReadonlyArray<string>): void => {
  const seen = new Set<string>();

  for (const name of names) {
    if (seen.has(name)) throw new Error(`Duplicate ${what}: ${name}`);
    seen.add(name);
  }
};

/**
 * What one adapter serves of a group. Each adapter projects its groups once and
 * reads nothing else, so an action it does not serve cannot influence its
 * names, routes, clients, pairing or acquisition.
 */
export interface Served {
  readonly group: Actions;
  readonly actions: ReadonlyArray<Action.Any>;
}

export const served = (
  groups: ReadonlyArray<Actions>,
  serves: (action: Action.Any) => boolean,
): ReadonlyArray<Served> =>
  groups.flatMap((group) => {
    const actions = group.actions.filter(serves);

    return actions.length === 0 ? [] : [{ group, actions }];
  });
