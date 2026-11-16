import { Schema } from "effect";
import { RpcMessage, RpcSerialization } from "effect/rpc";

export const parser = RpcSerialization.json.makeUnsafe();

export const encodeDefect = Schema.encodeSync(
  RpcSerialization.json.codecFor(Schema.Defect())
);

export const pingPong = () =>
  new WebSocketRequestResponsePair(
    String(parser.encode(RpcMessage.constPing)),
    String(parser.encode(RpcMessage.constPong))
  );

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

export const replyToClose = (
  socket: WebSocket,
  code: number,
  reason: string
) => {
  if (code >= 1000 && code !== 1005 && code !== 1006 && code !== 1015) {
    closeQuietly(socket, code, reason);
  } else {
    closeQuietly(socket);
  }
};

export const send = (
  socket: WebSocket,
  frame: RpcMessage.FromServerEncoded
) => {
  const encoded = parser.encode(frame);

  if (encoded === undefined) {
    return;
  }

  try {
    socket.send(encoded);
  } catch {
    return;
  }
};

export const died = (requestId: string | number, defect: unknown) =>
  RpcMessage.ResponseExitDieEncoded({
    requestId: RpcMessage.RequestId(requestId),
    encodedDefect: encodeDefect(defect),
  });
