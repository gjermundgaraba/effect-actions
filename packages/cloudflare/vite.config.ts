import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vite-plus";

import { pack } from "../../tools/pack.ts";

export default defineConfig({
  plugins: [
    cloudflareTest({ wrangler: { configPath: "./tests/wrangler.jsonc" } }),
  ],
  test: {
    include: ["tests/**/*.test.ts"],
    // Why: under @cloudflare/vitest-plugin 1.4.4, the warm-module response for a later file in a
    // pool slot can exceed what the runner's control socket accepts, 41 MB in 709 entries
    // measured on chat-rooms, which closes it with 1009 and loses the file as "Worker exited
    // unexpectedly"; two small files alone did not trigger it.
    fsModuleCache: false,
  },
  pack: pack("tsconfig.build.json"),
});
