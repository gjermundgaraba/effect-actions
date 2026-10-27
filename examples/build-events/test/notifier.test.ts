import { describe, expect, it } from "@effect/vitest";
import * as ActionHttp from "@gjermundgaraba/effect-actions/ActionHttp";
import * as Testing from "@gjermundgaraba/effect-actions/Testing";
import { Deferred, Effect, Layer } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import { KeyValueStore } from "effect/persistence";

import { Http } from "../src/Api.js";
import { Notices } from "../src/notifier/Notices.js";
import { notifier } from "../src/notifier/routes.js";
import { routes } from "../src/routes.js";
import { inMemory, settled } from "./support/memory.js";

describe("the notifier, by webhook", () => {
  it.effect("is told of each failed build its member may see", () =>
    Effect.gen(function* () {
      // Both services in memory: build-events POSTs to the notifier's routes, and the notifier
      // calls build-events. Each one's client reaches the other, a cycle no layer builds, so
      // the notifier's client waits for build-events' to be handed over.
      const toBuildEvents = yield* Deferred.make<HttpClient.HttpClient>();

      const handedOver = Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Effect.flatMap(Deferred.await(toBuildEvents), (client) =>
            client.execute(request)
          )
        )
      );

      const notifierRoutes = notifier({
        buildEvents: "http://build-events.internal",
        token: "grace",
        publicUrl: "https://hooks.example.com",
      }).pipe(Layer.provide(handedOver));

      // The notices and the watch's cursor are provided around both, so the test reads the ones
      // the notifier writes.
      const services = Testing.layer(routes).pipe(
        Layer.provide(inMemory(Testing.layer(notifierRoutes))),
        Layer.provideMerge(
          Layer.mergeAll(Notices.layerMemory, KeyValueStore.layerMemory)
        )
      );

      yield* Effect.gen(function* () {
        yield* Deferred.succeed(toBuildEvents, yield* HttpClient.HttpClient);

        const notices = yield* Notices;
        const cursors = yield* KeyValueStore.KeyValueStore;

        // The notifier's watch keeps a position once it is subscribed.
        yield* settled(cursors.has("failed-builds"));

        const ada = yield* ActionHttp.client(Http, {
          transformClient: HttpClient.mapRequest(
            HttpClientRequest.bearerToken("ada")
          ),
        });

        yield* ada.finishBuild({ pipeline: "api", status: "failed" });
        yield* ada.finishBuild({ pipeline: "web", status: "passed" });
        // Each build finished notifies `build.finished`: it is POSTed at once, no poll awaited.
        yield* ada.finishBuild({ pipeline: "web", status: "failed" });
        yield* settled(Effect.map(notices.all, (all) => all.length > 0));

        // grace sees the web pipeline alone, and the notifier asked for failures alone.
        expect(yield* notices.all).toStrictEqual([
          { id: "build-3", pipeline: "web", status: "failed" },
        ]);

        yield* ada.finishBuild({ pipeline: "web", status: "failed" });
        yield* settled(Effect.map(notices.all, (all) => all.length > 1));

        // Once build-4 is read, build-3 is handled: a restart resumes after the third build.
        expect(yield* cursors.get("failed-builds")).toMatch(/:3$/u);
      }).pipe(Effect.provide(services));
    })
  );
});
