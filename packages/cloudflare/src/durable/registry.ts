import { Effect } from "effect";

/**
 * The registry of a dispatcher, such as `Calls` or `Sockets`, which the one protocol it serves
 * registers with: `register` keeps a registry for a dispatcher `X.layer` made, and `of` finds it,
 * or dies naming `X.layer`.
 */
export const makeRegistries = <Dispatcher extends object, Registry>(
  protocol: string,
  dispatcher: string,
) => {
  // Why: registering is no concept of the dispatcher's own: only one protocol registers, so the
  // registry is reached through the dispatcher here rather than a method consumers would see.
  const registries = new WeakMap<Dispatcher, Registry>();

  return {
    register: (of: Dispatcher, registry: Registry) => void registries.set(of, registry),
    of: (of: Dispatcher) =>
      Effect.suspend(() => {
        const registry = registries.get(of);

        return registry === undefined
          ? Effect.die(
              new Error(
                `ActionDurableObject.${protocol} registers only with a ${dispatcher} that ${dispatcher}.layer built: provide ${dispatcher}.layer`,
              ),
            )
          : Effect.succeed(registry);
      }),
  };
};
