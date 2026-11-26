import { Effect, Option } from "effect";
import { Headers, HttpServerRequest } from "effect/http";

const ownedByTheRequest = (name: string) =>
  [
    "host",
    "connection",
    "keep-alive",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
  ].includes(name) ||
  ["content-", "accept", "proxy-", "sec-websocket-", "mcp-"].some((family) =>
    name.startsWith(family)
  );

/**
 * The headers of a request that a call into an entity carries, their names lowercased: every
 * one but its connection's (`host`, `connection`, `keep-alive`, `te`, `trailer`,
 * `transfer-encoding`, `upgrade`), its body's (`content-*`), what it accepts (`accept*`), a
 * proxy's (`proxy-*`), a WebSocket upgrade's (`sec-websocket-*`) and an MCP request's routing
 * headers (`mcp-*`). `reaching` sends these of the caller's request, and a socket host forwarding
 * a page's calls into an entity keeps these of the page's upgrade.
 */
export const forwardedHeaders = (headers: Headers.Input): Headers.Headers =>
  Headers.fromInput(
    Object.entries(Headers.fromInput(headers)).filter(
      ([name]) => !ownedByTheRequest(name)
    )
  );

export const forwarded = Effect.map(
  Effect.serviceOption(HttpServerRequest.HttpServerRequest),
  Option.match({
    onNone: () => Headers.empty,
    onSome: ({ headers }) => forwardedHeaders(headers),
  })
);
