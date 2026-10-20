import { describe, expect, it } from "@effect/vitest";
import { ConfigProvider, Effect, Fiber, Layer } from "effect";
import {
  HttpClient,
  HttpClientError,
  type HttpClientRequest,
  HttpClientResponse,
} from "effect/http";
import { TestClock } from "effect/testing";
import * as Action from "@gjermundgaraba/effect-actions/Action";
import { fakeFarm } from "../../src/platform/fake-farm.js";
import { printFarm } from "../../src/platform/print-farm.js";
import { printers } from "../../src/printers/handlers.js";
import { PrintFarmError } from "../../src/printers/Printers.js";

// What the tools do, with no transport: `Action.client` runs the same decoding and the same
// handlers a server runs. A public action has no caller, so a call needs none provided.

// The real `PrintFarm` over an upstream of the test's: its requests, its sign-in and its error
// mapping all run, and only the network is replaced. Its settings come from a Layer too.
const farmOver = (upstream: Layer.Layer<HttpClient.HttpClient>) =>
  printFarm.pipe(
    Layer.provide(upstream),
    Layer.provide(
      ConfigProvider.layer(
        ConfigProvider.fromEnvRecord({
          FARM_URL: "https://farm.example.test",
          FARM_USER: "agent",
          FARM_PASSWORD: "secret",
        }),
      ),
    ),
  );

// The fake farm, noting each request the service sends it. A request is noted as the service
// wrote it, before its client prepends FARM_URL, so the paths are relative.
const noting = (sent: Array<string>) =>
  Layer.effect(
    HttpClient.HttpClient,
    Effect.map(
      HttpClient.HttpClient,
      HttpClient.tapRequest((request) =>
        Effect.sync(() => sent.push(`${request.method} ${request.url}`)),
      ),
    ),
  ).pipe(Layer.provide(fakeFarm));

// A farm that lets the service sign in, then answers every other request with `answer`.
const farmThat = (
  answer: (
    request: HttpClientRequest.HttpClientRequest,
  ) => Effect.Effect<HttpClientResponse.HttpClientResponse, HttpClientError.HttpClientError>,
) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request, url) =>
      url.pathname === "/api/login"
        ? Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({ token: "session" })))
        : answer(request),
    ),
  );

const door = { id: "mk4-1", name: "MK4 by the door" };

describe("printers, in process", () => {
  it.effect("pauses, resumes and cancels a job, pause and cancel safe to repeat", () =>
    Effect.gen(function* () {
      const client = yield* Action.client(printers);
      const pause = client.set_paused({ printer_id: "mk4-1", paused: true });
      const cancel = client.cancel_print({ printer_id: "mk4-1" });
      const job = { file: "bracket.gcode", progress: 62 };

      expect(yield* pause).toEqual({ ...door, state: "paused", job });
      expect(yield* pause).toEqual({ ...door, state: "paused", job });
      expect(yield* client.set_paused({ printer_id: "mk4-1", paused: false })).toEqual({
        ...door,
        state: "printing",
        job,
      });
      expect(yield* cancel).toEqual({ ...door, state: "idle", job: null });
      expect(yield* cancel).toEqual({ ...door, state: "idle", job: null });
    }).pipe(Effect.provide(farmOver(fakeFarm))),
  );

  it.effect("signs in once at startup, however many tools are called", () => {
    const sent: Array<string> = [];

    return Effect.gen(function* () {
      const client = yield* Action.client(printers);

      yield* client.list_printers();
      yield* client.set_paused({ printer_id: "mk4-1", paused: true });

      expect(sent).toEqual([
        "POST /api/login",
        "GET /api/printers",
        "POST /api/printers/mk4-1/pause",
      ]);
    }).pipe(Effect.provide(farmOver(noting(sent))));
  });

  it.effect("refuses an id that could leave its place in the farm's URL, sending nothing", () => {
    const sent: Array<string> = [];

    return Effect.gen(function* () {
      const client = yield* Action.client(printers);

      for (const printer_id of ["..", "mk4-1/../..", "mk4-1?force=true", ""]) {
        const refused = yield* Effect.flip(client.cancel_print({ printer_id }));

        expect(refused).toBeInstanceOf(Action.InvalidInput);
      }

      expect(sent).toEqual(["POST /api/login"]);
    }).pipe(Effect.provide(farmOver(noting(sent))));
  });

  // The message is all a model gets of a failure, so each test asserts it.
  it.effect("fails with the declared error, carrying the farm's own reason", () =>
    Effect.gen(function* () {
      const client = yield* Action.client(printers);
      const busy = yield* Effect.flip(client.start_print({ printer_id: "mk4-1", file: "a.gcode" }));
      const unknown = yield* Effect.flip(client.get_camera_snapshot({ printer_id: "mk9" }));

      expect(busy).toBeInstanceOf(PrintFarmError);
      expect(busy.message).toBe(
        "The print farm refused: MK4 by the door is busy with bracket.gcode.",
      );
      expect(unknown).toBeInstanceOf(PrintFarmError);
      expect(unknown.message).toBe("The print farm refused: No printer has the id mk9.");
    }).pipe(Effect.provide(farmOver(fakeFarm))),
  );

  it.effect("says so when the farm cannot be reached", () =>
    Effect.gen(function* () {
      const client = yield* Action.client(printers);
      const error = yield* Effect.flip(client.list_printers());

      expect(error).toBeInstanceOf(PrintFarmError);
      expect(error.message).toBe("The print farm could not be reached.");
    }).pipe(
      Effect.provide(
        farmOver(
          farmThat((request) =>
            Effect.fail(
              new HttpClientError.HttpClientError({
                reason: new HttpClientError.TransportError({ request }),
              }),
            ),
          ),
        ),
      ),
    ),
  );

  it.effect("says so when the farm answers in a shape the service does not know", () =>
    Effect.gen(function* () {
      const client = yield* Action.client(printers);
      const error = yield* Effect.flip(client.list_printers());

      expect(error).toBeInstanceOf(PrintFarmError);
      expect(error.message).toBe("The print farm sent an answer this server could not read.");
    }).pipe(
      Effect.provide(
        farmOver(
          farmThat((request) =>
            Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({ rows: [] }))),
          ),
        ),
      ),
    ),
  );

  // `it.effect` runs on a test clock, so the thirty seconds pass when the test says so.
  it.effect("gives up on a farm that does not answer", () =>
    Effect.gen(function* () {
      const client = yield* Action.client(printers);
      const call = yield* Effect.forkChild(Effect.flip(client.list_printers()));

      yield* TestClock.adjust("30 seconds");

      const error = yield* Fiber.join(call);

      expect(error).toBeInstanceOf(PrintFarmError);
      expect(error.message).toBe("The print farm did not answer in time.");
    }).pipe(Effect.provide(farmOver(farmThat(() => Effect.never)))),
  );
});
