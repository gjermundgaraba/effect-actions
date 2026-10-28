import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vite-plus";

import { pack } from "../../tools/pack.ts";

export default defineConfig({
  plugins: [
    cloudflareTest({ wrangler: { configPath: "./tests/wrangler.jsonc" } }),
  ],
  test: {
    include: ["tests/**/*.test.ts"],
  },
  pack: pack("tsconfig.build.json"),
});
