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

export const forwarded = Effect.map(
  Effect.serviceOption(HttpServerRequest.HttpServerRequest),
  Option.match({
    onNone: () => Headers.empty,
    onSome: ({ headers }) =>
      Headers.fromInput(
        Object.entries(headers).filter(([name]) => !ownedByTheRequest(name))
      ),
  })
);
