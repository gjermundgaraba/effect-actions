import { expectTypeOf } from "@effect/vitest";
import type * as Event from "@gjermundgaraba/effect-actions/Event";
import { Effect, Layer } from "effect";

import * as ActionDurableObject from "../../src/durable/ActionDurableObject.js";
import * as ObjectServer from "../../src/durable/ObjectServer.js";
import type { Greeting } from "../support/app.js";
import { watchedRoutes } from "../support/events.js";
import { servedRoutes } from "../support/served.js";

expectTypeOf(ObjectServer.layer(watchedRoutes)).toEqualTypeOf<
  Layer.Layer<
    ObjectServer.ObjectServer | Event.Events,
    never,
    ActionDurableObject.State
  >
>();

expectTypeOf(ObjectServer.layer(servedRoutes)).toEqualTypeOf<
  Layer.Layer<
    ObjectServer.ObjectServer | Event.Events,
    never,
    ActionDurableObject.State | Greeting
  >
>();

expectTypeOf(
  ObjectServer.layer(
    Layer.effectDiscard(Effect.asVoid(ActionDurableObject.Alarm))
  )
).toEqualTypeOf<
  Layer.Layer<
    ObjectServer.ObjectServer | Event.Events,
    never,
    ActionDurableObject.State | ActionDurableObject.Alarm
  >
>();
