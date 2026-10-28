import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import * as ActionHttp from "@gjermundgaraba/effect-actions/ActionHttp";
import * as Testing from "@gjermundgaraba/effect-actions/Testing";
import { ConfigProvider, Effect, Fiber, Layer, Schema } from "effect";
import { Command } from "effect/cli";
import { HttpClient, HttpClientRequest } from "effect/http";
import { TestClock, TestConsole } from "effect/testing";

import { Http } from "../src/Api.js";
import { commands } from "../src/commands.js";
import { routes } from "../src/routes.js";
import { inMemory } from "./support/memory.js";

const served = Testing.layer(routes).pipe(Layer.provide(inMemory()));

const run = (token: string, args: readonly string[]) =>
  Command.runWith(commands, { version: "0" })(args).pipe(
    Effect.provide(
      ConfigProvider.layer(
        ConfigProvider.fromEnvRecord({ BUILDS_TOKEN: token })
      ).pipe(Layer.provideMerge(NodeServices.layer))
    )
  );

describe("the commands", () => {
  it.effect(
    "print each build a member may see as a line of JSON, until stopped",
    () =>
      Effect.gen(function* () {
        const watching = yield* Effect.forkChild(
          run("grace", ["watch", "build.finished"])
        );

        yield* TestClock.adjust("0 millis");

        const ada = yield* ActionHttp.client(Http, {
          transformClient: HttpClient.mapRequest(
            HttpClientRequest.bearerToken("ada")
          ),
        });

        yield* ada.finishBuild({ pipeline: "api", status: "passed" });
        yield* ada.finishBuild({ pipeline: "web", status: "passed" });
        yield* TestClock.adjust("5 seconds");
        yield* Fiber.interrupt(watching);

        const lines = yield* Schema.decodeUnknownEffect(
          Schema.Array(Schema.fromJsonString(Schema.Unknown))
        )(yield* TestConsole.logLines);

        expect(lines).toMatchObject([
          { _tag: "Occurrence", data: { id: "build-2", pipeline: "web" } },
        ]);
        expect(JSON.stringify(lines)).toMatch(/"cursor":"[^"]+:2"/u);
      }).pipe(Effect.provide(served))
  );

  it.effect(
    "print each step of a build on stderr as it starts, and the build on stdout",
    () =>
      Effect.gen(function* () {
        yield* run("ada", ["start-build", "--pipeline", "api"]);

        expect(yield* TestConsole.logLines).toStrictEqual([
          JSON.stringify(
            { id: "build-1", pipeline: "api", status: "passed" },
            null,
            2
          ),
        ]);
        expect(yield* TestConsole.errorLines).toStrictEqual([
          '{"step":"install","done":0,"total":3}',
          '{"step":"build","done":1,"total":3}',
          '{"step":"test","done":2,"total":3}',
        ]);
      }).pipe(Effect.provide(served))
  );

  it.effect(
    "print each line of a build's log as a line of JSON, as it arrives",
    () =>
      Effect.gen(function* () {
        yield* run("ada", [
          "finish-build",
          "--pipeline",
          "web",
          "--status",
          "failed",
        ]);
        yield* run("ada", ["tail-log", "--build-id", "build-1"]);

        expect((yield* TestConsole.logLines).slice(1)).toStrictEqual([
          '{"line":"failed"}',
        ]);
      }).pipe(Effect.provide(served))
  );
});
