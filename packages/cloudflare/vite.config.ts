import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vite-plus";
import { pack } from "../../tools/pack.ts";

export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: "./tests/wrangler.jsonc" } })],
  test: {
    include: ["tests/**/*.test.ts"],
    // Why: @cloudflare/vitest-plugin 1.4.4 answers a second runner's fetchWarmModules with every
    // module the filesystem module cache holds in one WebSocket message, 41 MB here, which the
    // runner's control socket closes with 1009 "Message is too large", reported as "Worker
    // exited unexpectedly": with the cache on, every test file after the first in a pool slot
    // is lost, as on CI's few cores.
    fsModuleCache: false,
  },
  pack: pack("tsconfig.build.json"),
});
