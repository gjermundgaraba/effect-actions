import { Effect, Schema } from "effect";
import { RpcSerialization } from "effect/rpc";
import type { RpcMessage } from "effect/rpc";

const socketPrefix = "effect-actions/socket#";

export const socketTag = (id: number) => `${socketPrefix}${id}`;

export const socketIdOf = (tags: readonly string[]) => {
  const tag = tags.find((found) => found.startsWith(socketPrefix));

  return tag === undefined ? 0 : Number(tag.slice(socketPrefix.length));
};

export const groupTag = (path: string) => `effect-actions/rpc:${path}`;

export const RequestId = Schema.Union([Schema.String, Schema.Finite]);

export const parser = RpcSerialization.json.makeUnsafe();

export const closeQuietly = (
  socket: WebSocket,
  code?: number,
  reason?: string
) => {
  try {
    if (code === undefined) {
      socket.close();
    } else {
      socket.close(code, reason);
    }
  } catch {
    return;
  }
};

export const sendFrame = (
  state: DurableObjectState,
  id: number,
  frame: RpcMessage.FromServerEncoded
) =>
  Effect.sync(() => {
    const encoded = parser.encode(frame);

    if (encoded === undefined) {
      return;
    }

    try {
      for (const socket of state.getWebSockets(socketTag(id))) {
        socket.send(encoded);
      }
    } catch {
      return;
    }
  });
