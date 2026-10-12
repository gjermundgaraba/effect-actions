import { describe, expect, it } from "@effect/vitest";
import { ConfigProvider, Effect, Layer, Schema } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as Testing from "@gjermundgaraba/effect-actions/Testing";
import { fakeFarm, picture } from "../src/printers/fake.js";
import { PrintFarm } from "../src/printers/farm.js";
import { PrintFarmError, Printers } from "../src/printers/Printers.js";
import { routes } from "../src/routes.js";

// What the MCP surface adds: the tools as listed, their results as sent, the origin check.
// The real routes answer in memory, and no port is opened.

// What the entrypoint reads from the environment, given to the test as a Layer.
const configured = ConfigProvider.layer(
  ConfigProvider.fromEnvRecord({
    FARM_URL: "https://farm.example.test",
    FARM_USER: "agent",
    FARM_PASSWORD: "secret",
    ALLOWED_ORIGINS: "https://console.example.test,https://wall.example.test",
  }),
);

// `Testing.layer` gives the test an `HttpClient` of its own, which reaches the routes. The
// fake farm is another `HttpClient`, provided to `PrintFarm.layer` alone.
const served = Testing.layer(routes).pipe(
  Layer.provide(PrintFarm.layer.pipe(Layer.provide(fakeFarm))),
  Layer.provide(configured),
);

// One tool of a `tools/list` answer, as far as this test reads it.
const Listed = Schema.Struct({
  result: Schema.Struct({
    tools: Schema.Array(
      Schema.Struct({
        name: Schema.String,
        annotations: Schema.Struct({
          title: Schema.String,
          readOnlyHint: Schema.Boolean,
          destructiveHint: Schema.Boolean,
          idempotentHint: Schema.Boolean,
        }),
      }),
    ),
  }),
});

describe("the tools, over MCP", () => {
  it.effect("lists every tool with the hints its contract states", () =>
    Effect.gen(function* () {
      // A raw request, for what no typed client shows: here, the listing itself.
      const response = yield* HttpClient.execute(Testing.mcpRequest("tools/list"));
      const { result } = yield* HttpClientResponse.schemaBodyJson(Listed)(response);

      const hints = (readOnlyHint: boolean, destructiveHint: boolean, idempotentHint: boolean) => ({
        readOnlyHint,
        destructiveHint,
        idempotentHint,
      });

      expect(result.tools).toEqual([
        {
          name: "list_printers",
          annotations: { title: "List printers", ...hints(true, false, false) },
        },
        {
          name: "get_camera_snapshot",
          annotations: { title: "Camera snapshot", ...hints(true, false, false) },
        },
        {
          name: "start_print",
          annotations: { title: "Start a print", ...hints(false, false, false) },
        },
        {
          name: "set_paused",
          annotations: { title: "Pause or resume a print", ...hints(false, false, true) },
        },
        {
          name: "cancel_print",
          annotations: { title: "Cancel a print", ...hints(false, true, true) },
        },
      ]);
    }).pipe(Effect.provide(served)),
  );

  it.effect("answers a camera's picture as an image beside the printer", () =>
    Effect.gen(function* () {
      // A client method per tool: it sends `tools/call` and decodes the result, the image
      // from its image block, as the handler returned it.
      const mcp = yield* Testing.mcpClient(Printers);

      expect(yield* mcp.get_camera_snapshot({ printer_id: "mk4-1" })).toEqual({
        printer: {
          id: "mk4-1",
          name: "MK4 by the door",
          state: "printing",
          job: { file: "bracket.gcode", progress: 62 },
        },
        image: { data: picture, mimeType: "image/png" },
      });
    }).pipe(Effect.provide(served)),
  );

  it.effect("answers the farm's refusal as the tool's declared error, message and all", () =>
    Effect.gen(function* () {
      const mcp = yield* Testing.mcpClient(Printers);
      const error = yield* Effect.flip(mcp.get_camera_snapshot({ printer_id: "mini-1" }));

      expect(error).toBeInstanceOf(PrintFarmError);
      expect(error.message).toBe("The print farm refused: Mini on the shelf is offline.");
    }).pipe(Effect.provide(served)),
  );

  it.effect("accepts the browser origins the configuration lists, and no other", () =>
    Effect.gen(function* () {
      const from = (origin: string) =>
        HttpClient.execute(Testing.mcpRequest("tools/list", {}, { headers: { origin } }));

      expect((yield* from("https://console.example.test")).status).toBe(200);
      expect((yield* from("https://wall.example.test")).status).toBe(200);
      expect((yield* from("https://elsewhere.example.test")).status).toBe(403);
    }).pipe(Effect.provide(served)),
  );

  it.effect("serves the host's own route beside the tools", () =>
    Effect.gen(function* () {
      const health = yield* HttpClient.get("/healthz");

      expect(yield* health.text).toBe("ok");
    }).pipe(Effect.provide(served)),
  );
});
