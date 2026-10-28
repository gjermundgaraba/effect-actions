import { Config } from "effect";

export const publicUrl = Config.String("PUBLIC_URL").pipe(
  Config.withDefault("http://localhost:3000")
);

const demoInspectorOrigin = "http://localhost:6274";

export const allowedOrigins = Config.all([
  publicUrl,
  Config.String("MCP_ORIGIN").pipe(Config.withDefault(demoInspectorOrigin)),
]).pipe(Config.map(([url, mcp]) => [new URL(url).origin, mcp]));
