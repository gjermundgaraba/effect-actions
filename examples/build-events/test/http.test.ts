import { describe, expect, it } from "@effect/vitest";
import * as Action from "@gjermundgaraba/effect-actions/Action";
import * as ActionHttp from "@gjermundgaraba/effect-actions/ActionHttp";
import * as Testing from "@gjermundgaraba/effect-actions/Testing";
import { Effect, Fiber, Layer, Stream } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import { TestClock } from "effect/testing";

import { Http } from "../src/Api.js";
import { BuildFinished } from "../src/builds/Builds.js";
import { DeployRequested } from "../src/deploys/Deploys.js";
import { routes } from "../src/routes.js";
import { inMemory } from "./support/memory.js";

const served = Testing.layer(routes).pipe(Layer.provide(inMemory()));

// One client of the binding per member: the token is the member, as in production.
const as = (token: string) =>
  ActionHttp.client(Http, {
    transformClient: HttpClient.mapRequest(
      HttpClientRequest.bearerToken(token)
    ),
  });

describe("the service, over HTTP", () => {
  it.effect(
    "streams each build a member may see, as SSE, as a call finishes it",
    () =>
      Effect.gen(function* () {
        const ada = yield* as("ada");
        const grace = yield* as("grace");

        // `watch` asks for `text/event-stream`, and the route holds the stream open.
        const watched = yield* grace
          .watch(BuildFinished)
          .pipe(Stream.take(1), Stream.runCollect, Effect.forkChild);

        // The watch starts from now: let it take its first position before builds finish.
        yield* TestClock.adjust("0 millis");
        yield* ada.finishBuild({ pipeline: "api", status: "passed" });
        yield* ada.finishBuild({ pipeline: "web", status: "passed" });

        expect(yield* Fiber.join(watched)).toMatchObject([
          { _tag: "Occurrence", data: { id: "build-2", pipeline: "web" } },
        ]);
      }).pipe(Effect.provide(served))
  );

  it.effect(
    "delivers deploy requests to a member that polls the route for JSON pages",
    () =>
      Effect.gen(function* () {
        const ada = yield* as("ada");
        const grace = yield* as("grace");

        // `mode: "poll"` asks for a page at a time, as a client that cannot hold a stream does.
        const polled = yield* grace
          .watch(
            DeployRequested,
            { environment: "production" },
            { mode: "poll" }
          )
          .pipe(Stream.take(1), Stream.runCollect, Effect.forkChild);

        yield* TestClock.adjust("0 millis");

        const deploy = yield* ada.requestDeploy({
          environment: "production",
          version: "1.0.9",
        });

        yield* TestClock.adjust("5 seconds");

        expect(deploy.approvers).toStrictEqual(["grace"]);
        expect(yield* Fiber.join(polled)).toMatchObject([
          {
            _tag: "Occurrence",
            data: { version: "1.0.9", approvers: ["grace"] },
          },
        ]);
      }).pipe(Effect.provide(served))
  );

  it.effect(
    "refuses a watch without a member's token, as the route's 401",
    () =>
      Effect.gen(function* () {
        const stranger = yield* as("mallory");

        expect(
          yield* Effect.flip(Stream.runDrain(stranger.watch(BuildFinished)))
        ).toBeInstanceOf(Action.Unauthenticated);
      }).pipe(Effect.provide(served))
  );
});
