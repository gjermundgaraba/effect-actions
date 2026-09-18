import type * as Action from "../Action.js";

/** The contract half of a group: what adapters and clients need, without `implement`. */
export interface Actions<
  Name extends string = string,
  A extends ReadonlyArray<Action.Any> = ReadonlyArray<Action.Any>,
  PolicyErrors extends ReadonlyArray<Action.Codec> = ReadonlyArray<Action.Codec>,
> {
  readonly name: Name;
  readonly actions: A;
  /** How HTTP answers failed decoding or encoding; native behavior without one. MCP is unaffected. */
  readonly schemaError: Action.SchemaErrorPolicy<PolicyErrors> | undefined;
}

/** The errors a group's policy may answer with, by lookup rather than a conditional type. */
export type PolicyError<G extends Actions> = NonNullable<G["schemaError"]>["errors"][number];

const validName = /^[A-Za-z][A-Za-z0-9_-]*$/;

/**
 * Action and group names become path segments, OpenAPI identifiers and client
 * method keys. `then` is refused because it would make a client thenable.
 */
export const assertName = (what: string, name: string): void => {
  if (!validName.test(name) || name === "then") throw new Error(`Invalid ${what}: ${name}`);
};

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

/** Project each group onto the actions `serves` accepts, dropping groups left empty. */
export const served = (
  groups: ReadonlyArray<Actions>,
  serves: (action: Action.Any) => boolean,
): ReadonlyArray<Served> =>
  groups.flatMap((group) => {
    const actions = group.actions.filter(serves);

    return actions.length === 0 ? [] : [{ group, actions }];
  });
