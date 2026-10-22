import { Effect, Schema } from "effect";
import { type RpcMessage, RpcSerialization } from "effect/rpc";

// Why: one tag per socket, across every protocol of the object, so a socket id alone, as a
// subscriber's record keeps it, finds its socket after hibernation, whichever path accepted it.
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

const parser = RpcSerialization.json.makeUnsafe();

/**
 * Sends `frame` to the socket `id`, given `path`, only if `path` accepted it: `true` when it
 * went, `false` when no such socket holds the id, or the one that does refuses it, as one the
 * object already closed does, which drops it.
 */
export const sendFrame = (
  state: DurableObjectState,
  id: number,
  frame: RpcMessage.FromServerEncoded,
  path?: string,
) =>
  Effect.sync(() => {
    const sockets = state
      .getWebSockets(socketTag(id))
      .filter((socket) => path === undefined || state.getTags(socket).includes(groupTag(path)));

    const encoded = parser.encode(frame);

    if (sockets.length === 0 || encoded === undefined) return false;

    try {
      for (const socket of sockets) socket.send(encoded);
    } catch {
      return false;
    }

    return true;
  });
