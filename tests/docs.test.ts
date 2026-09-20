import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it, onTestFinished } from "vite-plus/test";
import { Effect, Layer } from "effect";
import { FetchHttpClient, HttpRouter, HttpServer } from "effect/unstable/http";
import { routes } from "../examples/quickstart.js";
import { greeting } from "../examples/quickstart-client.js";
import { docsDirectory } from "../scripts/skill.ts";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

// Documented snippets that must stay byte-identical to a type-checked example.
it.each([
  ["README.md", "## Looks like this", "quickstart.ts"],
  ["docs/README.md", "## Minimal program", "quickstart.ts"],
  ["docs/ActionHttp.md", "### Client", "quickstart-client.ts"],
])("keeps %s %s aligned with its type-checked source", (document, heading, file) => {
  const source = read(`examples/${file}`)
    .trim()
    .replace(/"\.\.\/src\/(\w+)\.js"/g, '"@gjermundgaraba/effect-actions/$1"');

  const section = read(document).split(`\n${heading}\n`)[1];
  const snippet = section?.match(/\x60{3}ts\n([\s\S]*?)\n\x60{3}/)?.[1];
  expect(snippet).toBe(source);
});

// The skill is a copy of docs/, so every relative link must resolve inside docs/.
it("keeps relative links in docs/ inside docs/", () => {
  const pages = readdirSync(docsDirectory).filter((name) => name.endsWith(".md"));

  for (const page of pages) {
    const links = readFileSync(join(docsDirectory, page), "utf8").matchAll(
      /\]\((?!https?:|#)([^)#]+)(?:#[^)]*)?\)/g,
    );

    for (const [, target] of links) {
      expect(target, `${page} links to ${target}`).not.toMatch(/^\.\.?\//);
      expect(existsSync(join(docsDirectory, target ?? "")), `${page} links to ${target}`).toBe(
        true,
      );
    }
  }
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
