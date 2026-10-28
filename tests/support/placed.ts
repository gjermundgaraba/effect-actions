import { Effect, Layer, Schema, Stream } from "effect";
import { HttpClient } from "effect/http";

import * as Action from "../../src/contract/Action.js";
import * as Event from "../../src/contract/Event.js";
import * as ActionHttp from "../../src/http/ActionHttp.js";
import * as Testing from "../../src/testing/Testing.js";
import { authenticate } from "./app/authentication.js";
import { authorize, CurrentActor } from "./app/authorization.js";
import { Login } from "./app/binding.js";
import { Double, GetUser, RenameUser } from "./app/contracts.js";
import { double, userActions } from "./app/handlers.js";
import { Users } from "./app/users.js";
import { serve } from "./serve.js";

export const Bump = Action.make("bump", {
  description: "Count one more.",
  success: Schema.Int,
  readOnly: false,
  caller: CurrentActor,
});

export const Counted = Event.make("count.changed", {
  description: "The count, whole.",
  payload: { count: Schema.Int },
  caller: CurrentActor,
});

export const Countdown = Action.make("countdown", {
  description: "Count down to one, one number at a time.",
  input: { from: Schema.Int },
  success: Action.Stream(Schema.Int),
  readOnly: true,
  caller: Action.Anyone,
});

export const Fill = Action.make("fill", {
  description: "Fill slots, reporting each one filled.",
  input: { slots: Schema.Int },
  success: { filled: Schema.Int },
  progress: { slot: Schema.Int },
  readOnly: false,
  caller: Action.Anyone,
});

export const Placed = ActionHttp.make(
  [GetUser, RenameUser, Double, Bump, Counted, Countdown, Fill],
  {
    authentication: Login,
  }
);

const countingDown = Action.implement(Countdown, ({ from }) =>
  Stream.map(Stream.range(1, from), (n) => from + 1 - n)
);

const filling = Action.implement(Fill, ({ slots }, { progress }) =>
  Effect.as(
    Effect.forEach(
      Array.from({ length: slots }, (_, at) => at + 1),
      (slot) => progress({ slot })
    ),
    { filled: slots }
  )
);

const counter = (serving: { readonly counted: boolean }) => {
  let count = 0;

  return [
    Action.implement(
      Bump,
      Effect.map(
        Event.Events,
        (events) => () =>
          Effect.tap(
            Effect.sync(() => {
              count += 1;

              return count;
            }),
            () => events.notify(Counted)
          )
      ),
      { authorize }
    ),
    ...(serving.counted
      ? [
          Event.implement(
            Counted,
            { current: () => Effect.sync(() => ({ count })) },
            {
              authorize: Event.allowAll,
            }
          ),
        ]
      : []),
  ];
};

export const target = (
  options: {
    readonly withoutDouble?: boolean;
    readonly withoutCounted?: boolean;
  } = {}
) => {
  const requests: Request[] = [];

  const served = serve(
    ActionHttp.layer(Placed, [
      userActions,
      ...(options.withoutDouble === true ? [] : [double]),
      ...counter({ counted: options.withoutCounted !== true }),
      countingDown,
      filling,
    ]).pipe(Layer.provide([authenticate, Users.layerMemory, Event.layerMemory]))
  );

  const client = Effect.runSync(
    Effect.service(HttpClient.HttpClient).pipe(
      Effect.provide(
        Testing.layer(async (request) => {
          requests.push(request.clone());

          return await served.handler(request);
        })
      )
    )
  );

  return { client, requests, placed: ActionHttp.placed(Placed, () => client) };
};
