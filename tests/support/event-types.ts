import { Context, Effect, Schema, Stream } from "effect";

import * as Authentication from "../../src/authentication/Authentication.js";
import * as Action from "../../src/contract/Action.js";
import * as Event from "../../src/contract/Event.js";

export class Caller extends Context.Service<Caller, string>()(
  "events-types/Caller"
) {}

export class Store extends Context.Service<Store, string>()(
  "events-types/Store"
) {}

export class Region extends Context.Service<Region, string>()(
  "events-types/Region"
) {}

export class Quota extends Schema.TaggedError<
  Quota,
  { readonly brand: unique symbol }
>()("Quota", {}, { httpApiStatus: 429 }) {}

export const Login = Authentication.make("events-types.Login", Caller, {
  principal: (caller) => caller,
});

export const Watched = Event.make("account.watched", {
  description: "",
  input: { id: Schema.String },
  payload: { by: Schema.String },
  caller: Caller,
});

export const Ticked = Event.make("clock.ticked", {
  description: "",
  payload: { at: Schema.Finite },
  caller: Action.Anyone,
});

export const Open = Action.make("open", {
  description: "",
  readOnly: true,
  caller: Action.Anyone,
});

export const watched = Event.implement(
  Watched,
  Effect.as(Store, {
    check: () => Effect.as(Region, { cursor: "0", events: [] }),
  }),
  { authorize: Event.allowAll }
);

export const readingBoth = Event.implement(
  Watched,
  {
    check: () =>
      Effect.flatMap(Caller, () =>
        Effect.as(Region, { cursor: "0", events: [] })
      ),
    key: () => Region,
  },
  { authorize: Event.allowAll }
);

export const watchedPlainly = Event.implement(
  Watched,
  { check: () => Effect.succeed({ cursor: "0", events: [] }) },
  { authorize: Event.allowAll }
);

export const ticks = Event.implement(Ticked, { log: { emit: Stream.never } });

export const opened = Action.implement(Open, () => Effect.void);
