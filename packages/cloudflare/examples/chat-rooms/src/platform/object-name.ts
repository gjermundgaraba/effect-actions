import { Effect, Layer } from "effect";
import * as ActionDurableObject from "@gjermundgaraba/effect-actions-cloudflare/ActionDurableObject";
import { Room } from "../chat/room.js";

// The room an instance holds is the name the Worker reached its object by, `getByName(room)`.
// An object reached by an id has none, which is a bug in the Worker.
export const layerRoom = Layer.effect(Room)(
  Effect.flatMap(Effect.service(ActionDurableObject.State), ({ id }) =>
    Effect.fromNullishOr(id.name).pipe(Effect.orDie),
  ),
);
