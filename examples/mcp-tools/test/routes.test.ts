import { describe, expect, it } from "@effect/vitest";
import * as ActionMcp from "@gjermundgaraba/effect-actions/ActionMcp";
import * as Testing from "@gjermundgaraba/effect-actions/Testing";
import { ConfigProvider, Effect, Layer, Schema } from "effect";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

import { fakeFarm, picture } from "../src/platform/fake-farm.js";
import { printFarm } from "../src/platform/print-farm.js";
import { PrintFarmError, Printers } from "../src/printers/Printers.js";
import { routes } from "../src/routes.js";

const farm = {
  FARM_URL: "https://farm.example.test",
  FARM_USER: "agent",
  FARM_PASSWORD: "secret",
};

const servedWith = (environment: Record<string, string>) =>
  Testing.layer(routes).pipe(
    Layer.provide(printFarm.pipe(Layer.provide(fakeFarm))),
    Layer.provide(
      ConfigProvider.layer(ConfigProvider.fromEnvRecord(environment))
    )
  );

const served = servedWith({
  ...farm,
  ALLOWED_ORIGINS: "https://console.example.test,https://wall.example.test",
});

const preflight = (origin: string) =>
  HttpClient.execute(
    HttpClientRequest.make("OPTIONS")("/mcp", {
      headers: {
        origin,
        "access-control-request-method": "POST",
        "access-control-request-headers": "content-type, mcp-protocol-version",
      },
    })
  );

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
      })
    ),
  }),
});

const hints = (
  readOnlyHint: boolean,
  destructiveHint: boolean,
  idempotentHint: boolean
) => ({
  readOnlyHint,
  destructiveHint,
  idempotentHint,
});

const from = (origin: string) =>
  HttpClient.execute(
    ActionMcp.request("tools/list", {}, { headers: { origin } })
  );

describe("the tools, over MCP", () => {
  it.effect("lists every tool with its title and hints as sent", () =>
    Effect.gen(function* () {
      const response = yield* HttpClient.execute(
        ActionMcp.request("tools/list")
      );

      const { result } =
        yield* HttpClientResponse.schemaBodyJson(Listed)(response);

      expect(result.tools).toStrictEqual([
        {
          name: "list_printers",
          annotations: { title: "List printers", ...hints(true, false, false) },
        },
        {
          name: "get_camera_snapshot",
          annotations: {
            title: "Camera snapshot",
            ...hints(true, false, false),
          },
        },
        {
          name: "start_print",
          annotations: { title: "Start a print", ...hints(false, true, false) },
        },
        {
          name: "set_paused",
          annotations: {
            title: "Pause or resume a print",
            ...hints(false, true, true),
          },
        },
        {
          name: "cancel_print",
          annotations: { title: "Cancel a print", ...hints(false, true, true) },
        },
      ]);
    }).pipe(Effect.provide(served))
  );

  it.effect("answers a camera's picture as an image beside the printer", () =>
    Effect.gen(function* () {
      const mcp = yield* ActionMcp.client(Printers);

      expect(
        yield* mcp.get_camera_snapshot({ printer_id: "mk4-1" })
      ).toStrictEqual({
        printer: {
          id: "mk4-1",
          name: "MK4 by the door",
          state: "printing",
          job: { file: "bracket.gcode", progress: 62 },
        },
        image: { data: picture, mimeType: "image/png" },
      });
    }).pipe(Effect.provide(served))
  );

  it.effect(
    "answers the farm's refusal as the tool's declared error, message and all",
    () =>
      Effect.gen(function* () {
        const mcp = yield* ActionMcp.client(Printers);

        const error = yield* Effect.flip(
          mcp.get_camera_snapshot({ printer_id: "mini-1" })
        );

        expect(error).toBeInstanceOf(PrintFarmError);
        expect(error.message).toBe(
          "The print farm refused: Mini on the shelf is offline."
        );
      }).pipe(Effect.provide(served))
  );

  it.effect(
    "accepts the browser origins the configuration lists, and no other",
    () =>
      Effect.gen(function* () {
        expect((yield* from("https://console.example.test")).status).toBe(200);
        expect((yield* from("https://wall.example.test")).status).toBe(200);
        expect((yield* from("https://elsewhere.example.test")).status).toBe(
          403
        );
      }).pipe(Effect.provide(served))
  );

  it.effect(
    "answers a listed origin's CORS preflight, and its headers on a tool's answer",
    () =>
      Effect.gen(function* () {
        const asked = yield* preflight("https://console.example.test");

        expect(asked.status).toBe(204);
        expect(asked.headers["access-control-allow-origin"]).toBe(
          "https://console.example.test"
        );
        expect(asked.headers["access-control-allow-methods"]).toBe(
          "POST, DELETE"
        );
        expect(asked.headers["access-control-allow-headers"]).toContain(
          "MCP-Protocol-Version"
        );

        const listed = yield* HttpClient.execute(
          ActionMcp.request(
            "tools/list",
            {},
            { headers: { origin: "https://console.example.test" } }
          )
        );

        expect(listed.headers["access-control-allow-origin"]).toBe(
          "https://console.example.test"
        );
        expect(listed.headers["access-control-expose-headers"]).toContain(
          "Mcp-Session-Id"
        );

        expect(
          (yield* preflight("https://elsewhere.example.test")).headers
        ).not.toHaveProperty("access-control-allow-origin");
      }).pipe(Effect.provide(served))
  );

  it.effect(
    "names its one configured origin to every preflight, and still refuses any other",
    () =>
      Effect.gen(function* () {
        const asked = yield* preflight("https://elsewhere.example.test");

        expect(asked.status).toBe(204);
        expect(asked.headers["access-control-allow-origin"]).toBe(
          "https://console.example.test"
        );

        const called = yield* HttpClient.execute(
          ActionMcp.request(
            "tools/list",
            {},
            { headers: { origin: "https://elsewhere.example.test" } }
          )
        );

        expect(called.status).toBe(403);
        expect(called.headers["access-control-allow-origin"]).toBe(
          "https://console.example.test"
        );
      }).pipe(
        Effect.provide(
          servedWith({
            ...farm,
            ALLOWED_ORIGINS: "https://console.example.test",
          })
        )
      )
  );

  it.effect("allows no origin where none is configured", () =>
    Effect.gen(function* () {
      const asked = yield* preflight("https://console.example.test");

      expect(asked.headers).not.toHaveProperty("access-control-allow-origin");
    }).pipe(Effect.provide(servedWith(farm)))
  );

  it.effect("serves the host's own route beside the tools", () =>
    Effect.gen(function* () {
      const health = yield* HttpClient.get("/healthz");

      expect(yield* health.text).toBe("ok");
    }).pipe(Effect.provide(served))
  );
});
