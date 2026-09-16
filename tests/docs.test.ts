import { readFileSync } from "node:fs";
import { expect, it, onTestFinished } from "vite-plus/test";
import { Effect, Layer } from "effect";
import { FetchHttpClient, HttpRouter, HttpServer } from "effect/unstable/http";
import { routes } from "../examples/quickstart.js";
import { greeting } from "../examples/quickstart-client.js";

it.each([
  ["## Quickstart", "quickstart.ts"],
  ["## HTTP client", "quickstart-client.ts"],
])("keeps %s aligned with its type-checked source", (heading, file) => {
  const source = readFileSync(new URL(`../examples/${file}`, import.meta.url), "utf8")
    .trim()
    .replace("../src/index.js", "@gjermundgaraba/effect-actions");

  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  const section = readme.split(heading)[1];
  const snippet = section?.match(/\x60{3}ts\n([\s\S]*?)\n\x60{3}/)?.[1];
  expect(snippet).toBe(source);
});

it("runs the documented client against the quickstart routes", async () => {
  const web = HttpRouter.toWebHandler(routes.pipe(Layer.provide(HttpServer.layerServices)), {
    disableLogger: true,
  });

  onTestFinished(() => web.dispose());

  const result = await Effect.runPromise(
    greeting.pipe(
      Effect.provideService(FetchHttpClient.Fetch, (input, init) =>
        web.handler(new Request(input, init)),
      ),
    ),
  );

  expect(result).toBe("Hello, Ada!");
});
