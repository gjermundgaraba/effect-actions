import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vite-plus";

import { receiver } from "./test/receiver.js";

export default defineConfig({
  plugins: [
    cloudflareTest({
      main: "./test/worker.ts",
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: { outboundService: receiver },
    }),
  ],
  test: {
    include: ["test/**/*.test.ts"],
    fsModuleCache: false,
  },
});
