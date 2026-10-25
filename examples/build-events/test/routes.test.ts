import { describe, expect, it } from "@effect/vitest";
import { Effect, Fiber, Layer, Stream } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import { TestClock } from "effect/testing";
import * as Action from "@gjermundgaraba/effect-actions/Action";
import * as ActionMcp from "@gjermundgaraba/effect-actions/ActionMcp";
import * as Testing from "@gjermundgaraba/effect-actions/Testing";
import { BuildFinished, FinishBuild } from "../src/builds/Builds.js";
import { DeployRequested, RequestDeploy } from "../src/deploys/Deploys.js";
import { Login } from "../src/identity/Identity.js";
import { routes } from "../src/routes.js";
import { inMemory } from "./support/memory.js";

// What the wire adds: the real routes, behind their real authentication, answering in memory.
// No port is opened. The subscriber is the token each client sends, as in production.
const served = Testing.layer(routes).pipe(Layer.provide(inMemory));

const as = (token: string) => ({
  authentication: Login,
  transformClient: HttpClient.mapRequest(HttpClientRequest.bearerToken(token)),
});

describe("the service, over MCP", () => {
  it.effect("pushes each build a member may see, as a tool call finishes it", () =>
    Effect.gen(function* () {
      // A client lists the contracts it uses: the action it calls, the event it watches.
      const ada = yield* ActionMcp.client([FinishBuild], as("ada"));
      const grace = yield* ActionMcp.client([BuildFinished], as("grace"));

      const watched = yield* grace
        .watch(BuildFinished)
        .pipe(Stream.take(1), Stream.runCollect, Effect.forkChild);

      // The watch starts from now: let it take its first position before builds finish.
      yield* TestClock.adjust("0 millis");
      yield* ada.finishBuild({ pipeline: "api", status: "passed" });
      // Each build finished notifies `build.finished`: the server asks the store at once, and
      // pushes what it answers.
      yield* ada.finishBuild({ pipeline: "web", status: "passed" });

      expect(yield* Fiber.join(watched)).toMatchObject([
        { _tag: "Occurrence", data: { id: "build-2", pipeline: "web" } },
      ]);
    }).pipe(Effect.provide(served)),
  );

  it.effect("delivers deploy requests to a member that polls, standing them by meanwhile", () =>
    Effect.gen(function* () {
      const ada = yield* ActionMcp.client([RequestDeploy], as("ada"));
      const grace = yield* ActionMcp.client([DeployRequested], as("grace"));

      // `mode: "poll"` asks with `events/poll`, as a client that cannot hold a stream does.
      const polled = yield* grace
        .watch(DeployRequested, { environment: "production" }, { mode: "poll" })
        .pipe(Stream.take(1), Stream.runCollect, Effect.forkChild);

      yield* TestClock.adjust("0 millis");

      const deploy = yield* ada.requestDeploy({ environment: "production", version: "1.0.9" });

      yield* TestClock.adjust("5 seconds");

      // Between polls, grace stands by: the server holds the subscription hook for 5 minutes
      // after each poll, keyed by grace's principal.
      expect(deploy.approvers).toEqual(["grace"]);
      expect(yield* Fiber.join(polled)).toMatchObject([
        { _tag: "Occurrence", data: { version: "1.0.9", approvers: ["grace"] } },
      ]);
    }).pipe(Effect.provide(served)),
  );

  it.effect("refuses a watch without a member's token", () =>
    Effect.gen(function* () {
      const stranger = yield* ActionMcp.client([BuildFinished], as("mallory"));

      expect(yield* Effect.flip(Stream.runDrain(stranger.watch(BuildFinished)))).toBeInstanceOf(
        Action.Unauthenticated,
      );
    }).pipe(Effect.provide(served)),
  );
});
