import { expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";

import * as Action from "../../src/contract/Action.js";
import * as ActionHttp from "../../src/http/ActionHttp.js";
import * as Testing from "../../src/testing/Testing.js";
import { post, send } from "../support/requests.js";

const Echo = Action.make("echo", {
  description: "Echo the text",
  readOnly: true,
  caller: Action.Anyone,
  input: { text: Schema.String },
  success: Schema.String,
});

const app = Action.implement(Echo, ({ text }) => Effect.succeed(text));

it.effect(
  "answers a method other than POST on an action's route, a readOnly one's included, with 404",
  () =>
    Effect.gen(function* () {
      const statuses = yield* Effect.forEach(
        ["GET", "PUT", "DELETE"],
        (method) =>
          Effect.map(
            send(new Request("http://localhost/api/echo", { method })),
            ({ status }) => status
          )
      );

      expect((yield* send(post("/api/echo", { text: "served" }))).status).toBe(
        200
      );
      expect(statuses).toStrictEqual([404, 404, 404]);
    }).pipe(
      Effect.provide(
        Testing.layer(ActionHttp.layer(ActionHttp.make([Echo]), app))
      )
    )
);
