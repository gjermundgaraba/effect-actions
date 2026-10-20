import { Context } from "effect";

/**
 * The object's own `DurableObjectState`, `ctx`: its storage, its id, its alarm and its sockets.
 * A startup service of the object's services, routes and alarm, one per instance, so a store
 * over `storage.sql` is a Layer requiring it.
 */
export class State extends Context.Service<State, DurableObjectState>()(
  "effect-actions-cloudflare/ActionDurableObject/State",
) {}
