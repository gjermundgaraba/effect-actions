import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vite-plus";

// Its tests run inside the Workers runtime, on the Worker wrangler.jsonc describes.
export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: "./wrangler.jsonc" } })],
  test: {
    include: ["test/**/*.test.ts"],
    // Why: @cloudflare/vitest-plugin 1.4.4 answers a second runner's fetchWarmModules with every
    // module the filesystem module cache holds in one WebSocket message, 41 MB here, which the
    // runner's control socket closes with 1009 "Message is too large", reported as "Worker
    // exited unexpectedly": with the cache on, every test file after the first in a pool slot
    // is lost, as on CI's few cores.
    fsModuleCache: false,
  },
});
