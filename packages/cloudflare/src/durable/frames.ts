import { Effect, Schema } from "effect";
import { type RpcMessage, RpcSerialization } from "effect/rpc";

// Why: one tag per socket, across every protocol of the object, so a response's client id finds
// its socket after hibernation, whichever path accepted it.
const socketPrefix = "effect-actions/socket#";

/** The tag a socket carries for its id, unique among the object's sockets. */
export const socketTag = (id: number) => `${socketPrefix}${id}`;

/** The id a socket's tags give it, or 0, which no socket is given, for one no protocol accepted. */
export const socketIdOf = (tags: ReadonlyArray<string>) => {
  const tag = tags.find((found) => found.startsWith(socketPrefix));

  return tag === undefined ? 0 : Number(tag.slice(socketPrefix.length));
};

/** The tag a socket carries for the `layerWebSocket` path that accepted it. */
export const groupTag = (path: string) => `effect-actions/rpc:${path}`;

/** A request's id on the wire, a number or a string, which a client tells apart. */
export const RequestId = Schema.Union([Schema.String, Schema.Number]);

/** The object's JSON parser, which keeps no state between frames. */
export const parser = RpcSerialization.json.makeUnsafe();

/** Closes `socket` with `code`, or with none, unless it is already closing. */
export const closeQuietly = (socket: WebSocket, code?: number, reason?: string) => {
  try {
    if (code === undefined) socket.close();
    else socket.close(code, reason);
  } catch {
    // Why: a socket already closing refuses a second close, and is gone either way.
  }
};

/** Sends `frame` to the socket `id`, if one holds it and takes it: one the object closed does not. */
export const sendFrame = (
  state: DurableObjectState,
  id: number,
  frame: RpcMessage.FromServerEncoded,
) =>
  Effect.sync(() => {
    const encoded = parser.encode(frame);

    if (encoded === undefined) return;

    try {
      for (const socket of state.getWebSockets(socketTag(id))) socket.send(encoded);
    } catch {
      // Why: a socket closing as the frame is sent drops it, as its client is gone.
    }
  });
