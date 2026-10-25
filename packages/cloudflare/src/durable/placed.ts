import { Effect, Layer } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import * as Action from "@gjermundgaraba/effect-actions/Action";
import * as ActionHttp from "@gjermundgaraba/effect-actions/ActionHttp";
import type * as Event from "@gjermundgaraba/effect-actions/Event";

const placing: unique symbol = Symbol.for("effect-actions-cloudflare/ActionDurableObject/placed");

type Contract<H extends ActionHttp.Any> = H["actions"][number] | H["events"][number];

/**
 * The key of each contract of `H`, by its name, as `placed` takes them: the name of the object
 * serving a call or a subscription, read from its input.
 */
export type PlacementKeys<H extends ActionHttp.Any> = {
  readonly [C in Contract<H> as C["name"]]: (input: C["input"]["Type"]) => string;
};

/** What an object's `make` or `handlers` checks each served input by. */
interface Placing {
  readonly contracts: ReadonlySet<Action.Any | Event.Any>;
  readonly keys: { readonly [name: string]: (input: Action.Any["input"]["Type"]) => string };
}

/**
 * What `placed` returns: the objects whose routes serve `binding`, each the one an input's key
 * names. Given to `make` or `handlers` as `placed`, it is what the object checks each input by;
 * given to `reaching` with the namespace, what a Worker serves.
 */
export interface Placement<H extends ActionHttp.Any> {
  readonly binding: H;
  readonly [placing]: Placing;
}

/** Any placement, as `make` and `handlers` take it. */
export type AnyPlacement = Placement<ActionHttp.Any>;

/**
 * The actions and event types of `binding` served in Durable Objects, each call and subscription
 * in the object its contract's key in `keys` names for its input, reached by
 * `getByName(keys[contract.name](input))`. Each object is
 * given it as `make`'s or `handlers`' `placed`, so that it refuses an input naming another
 * object, and serves `binding` in an `ActionHttp.layer` of its routes, where each call arrives; a
 * Worker serves `reaching(placement, () => env.ROOM)` on any surface.
 */
export const placed = <const H extends ActionHttp.Any>(
  binding: H,
  keys: NoInfer<PlacementKeys<H>>,
): Placement<H> => ({
  binding,
  [placing]: {
    contracts: new Set<Action.Any | Event.Any>([...binding.actions, ...binding.events]),
    keys,
  },
});

const keyOf = (
  placement: AnyPlacement,
  contract: Action.Any | Event.Any,
  input: Action.Any["input"]["Type"],
) => {
  const key = placement[placing].keys[contract.name];

  if (key === undefined)
    throw new Error(
      `ActionDurableObject.placed: its keys hold none for ${contract.name} (give placed a key for each contract of its binding, by name)`,
    );

  return key(input);
};

/**
 * The implementations a Worker serves of `placement`, reaching its objects in the namespace
 * `namespace` answers, `() => env.ROOM`: beside the Worker's own, on any surface, each call and
 * subscription sent on to the object its input's key names, as `ActionHttp.placed` sends it on.
 *
 * **Gotchas**
 *
 * - `namespace` is called as each call is sent, never as the module evaluates, so it reads `env` from `cloudflare:workers`, which a module-level value finds unset.
 * - Its rules, a credential verified by the Worker and again in the object among them, are `ActionHttp.placed`'s.
 * - An event an object's socket serves through it holds a request to the other object open while it is watched: both stay awake, billed, and neither hibernates. Serve an event in the object whose socket follows it.
 */
export const reaching = <H extends ActionHttp.Any>(
  placement: Placement<H>,
  namespace: () => DurableObjectNamespace,
): ActionHttp.Placed<H> => {
  const fetching = Effect.runSync(
    Effect.provide(Effect.service(HttpClient.HttpClient), FetchHttpClient.layer),
  ).pipe(HttpClient.mapRequest(HttpClientRequest.prependUrl("https://object")));

  return ActionHttp.placed(placement.binding, (input, contract) => {
    const stub = namespace().getByName(keyOf(placement, contract, input));

    return HttpClient.transform(fetching, (sent) =>
      Effect.provideService(sent, FetchHttpClient.Fetch, (url, init) => stub.fetch(url, init)),
    );
  });
};

/**
 * The input check of an object named `name`, given `placement`: an input of one of its contracts
 * whose key names another object is refused.
 */
// Why: the Worker decoded the input to pick the object, and the object decodes it again, since
// only the input it decodes is the one its handler is given: the check runs on that one.
export const layerInputCheck = (placement: AnyPlacement, name: string | undefined) =>
  Layer.succeed(Action.InputCheck)((contract, input) => {
    if (!placement[placing].contracts.has(contract)) return Effect.void;

    const named = keyOf(placement, contract, input);

    return named === name
      ? Effect.void
      : Effect.fail(
          new Action.Forbidden({
            message: `This object is ${String(name)}, and the input of ${contract.name} names ${named}`,
          }),
        );
  });
