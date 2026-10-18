import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vite-plus";

// Its tests run inside the Workers runtime, on the Worker wrangler.jsonc describes.
export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: "./wrangler.jsonc" } })],
  test: { include: ["test/**/*.test.ts"] },
});
