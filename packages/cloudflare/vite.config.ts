import { globSync } from "node:fs";
import { basename } from "node:path";
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vite-plus";

const publicModules = Object.fromEntries(
  globSync("src/*/*.ts")
    .map((path): [string, string] => [basename(path, ".ts"), path])
    .filter(([module]) => /^[A-Z]/u.test(module)),
);

export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: "./tests/wrangler.jsonc" } })],
  test: { include: ["tests/**/*.test.ts"] },
  pack: {
    entry: publicModules,
    unbundle: true,
    deps: { resolveDepSubpath: true },
    dts: {
      generator: "tsgo",
    },
    exports: {
      devExports: true,
      customExports: (exports) =>
        Object.fromEntries(
          Object.entries(exports).map(([path, target]) => [
            path === "." ? `./${Object.keys(publicModules).join()}` : path,
            target,
          ]),
        ),
    },
  },
});
