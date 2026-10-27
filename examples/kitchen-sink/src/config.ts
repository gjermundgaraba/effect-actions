import { Config } from "effect";

// What a deployment sets. A `Config` is only a description: each is read where a layer is
// built, so importing this file reads nothing, and a test runs on the defaults.

/** Where callers reach the public port: the OAuth resource, and a Host the server answers to. */
export const publicUrl = Config.String("PUBLIC_URL").pipe(
  Config.withDefault("http://localhost:3000")
);

/**
 * The origins whose pages may call the public port: the web app's, which is the server's own,
 * and one other, a browser MCP client's.
 */
export const allowedOrigins = Config.all([
  publicUrl,
  // DEMO ONLY: the default is the MCP Inspector's local origin. A page of any origin listed
  // passes the request policy and CORS, so a deployment names its own client's.
  Config.String("MCP_ORIGIN").pipe(Config.withDefault("http://localhost:6274")),
]).pipe(Config.map(([url, mcp]) => [new URL(url).origin, mcp]));
