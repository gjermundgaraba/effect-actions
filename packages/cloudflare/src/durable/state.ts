import { Context, Effect } from "effect";

/**
 * The object's own `DurableObjectState`, `ctx`: its storage, its id, its alarm and its sockets.
 * A startup service of the object's services, routes and alarm, one per instance, so a store
 * over `storage.sql` is a Layer requiring it.
 */
export class State extends Context.Service<State, DurableObjectState>()(
  "effect-actions-cloudflare/ActionDurableObject/State"
) {}

/**
 * The name the Worker reached the object by, `getByName(name)`, from `State`'s id: what the
 * object is, such as its room, as a startup service, `Layer.effect(Room)(name)`.
 *
 * **Gotchas**
 *
 * - An object reached by an id that carries no name, from `idFromString` or `newUniqueId`, dies at once, `was reached by an id that carries none`: reach it with `getByName`.
 */
export const name: Effect.Effect<string, never, State> = Effect.flatMap(
  Effect.service(State),
  ({ id }) =>
    id.name === undefined
      ? Effect.die(
          new Error(
            `ActionDurableObject.name reads the name the Worker reached the object by, and the object ${id.toString()} was reached by an id that carries none, as from idFromString or newUniqueId: reach it with getByName(name)`
          )
        )
      : Effect.succeed(id.name)
);
