import { describe, expect, it } from "@effect/vitest";
import { Layer } from "effect";
import { HttpRouter, HttpServer } from "effect/http";

import { withRequestPolicy } from "../src/request-policy.js";

describe("the quickstart request policy", () => {
  it("guards the quickstart routes and leaves the health probe reachable", async () => {
    const web = HttpRouter.toWebHandler(
      withRequestPolicy(new URL("https://greetings.example")).pipe(
        Layer.provide(HttpServer.layerServices)
      ),
      { disableLogger: true }
    );

    try {
      for (const [host, origin, status, body] of [
        [
          "greetings.example",
          "https://greetings.example",
          200,
          '"Hello, Ada!"',
        ],
        ["other.example", "https://greetings.example", 403, "Forbidden"],
        ["greetings.example", "https://other.example", 403, "Forbidden"],
      ] as const) {
        const response = await web.handler(
          new Request("https://greetings.example/api/greet", {
            method: "POST",
            headers: { host, origin, "content-type": "application/json" },
            body: JSON.stringify({ name: "Ada" }),
          })
        );

        expect(response.status).toBe(status);

        await expect(response.text()).resolves.toBe(body);
      }

      const health = await web.handler(new Request("https://internal/healthz"));

      expect(health.status).toBe(200);
      await expect(health.text()).resolves.toBe("ok");
    } finally {
      await web.dispose();
    }
  });
});
