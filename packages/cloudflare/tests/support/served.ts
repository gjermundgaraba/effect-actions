import { Effect, Layer, Scheduler } from "effect";
import { HttpRouter, HttpServerResponse } from "effect/http";

import { Greeting } from "./app.js";
import { watchedRoutes } from "./events.js";

export const eventScheduler = new Scheduler.MixedScheduler("sync");

export const servedRoutes = Layer.mergeAll(
  watchedRoutes,
  HttpRouter.add(
    "GET",
    "/scheduler",
    Effect.map(Scheduler.Scheduler, (scheduler) =>
      HttpServerResponse.text(
        scheduler === eventScheduler ? "the event's" : "another"
      )
    )
  ),
  HttpRouter.add(
    "GET",
    "/greeting",
    Effect.map(Greeting, (greeting) => HttpServerResponse.text(greeting))
  )
);
