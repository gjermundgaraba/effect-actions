import { Effect, Option, Predicate } from "effect";
import type { Headers } from "effect/http";
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

/** The storage key holding the next socket id, so no id names two sockets. */
export const nextSocketKey = "effect-actions/socket/next";

const socketHeader = "effect-actions-socket";

const pathHeader = "effect-actions-socket-path";

// Why: a request's headers are its caller's, over the stub and Effect's HTTP protocol, so a
// socket's id in them proves nothing: the protocol signs it with this instance's secret, which
// no caller can know, and an eviction makes a new one, which the next message carries.
const secrets = new WeakMap<DurableObjectState, string>();

const secretOf = (state: DurableObjectState) => {
  const known = secrets.get(state);

  if (known !== undefined) return known;

  const made = crypto.randomUUID();

  secrets.set(state, made);

  return made;
};

/**
 * A socket request's headers as the server reads them: the client's, without any under the
 * names the protocol owns, then the socket's id, signed, and the path of its protocol.
 */
export const socketHeaders = (
  state: DurableObjectState,
  id: number,
  path: string,
  headers: ReadonlyArray<readonly [string, string]>,
): Array<[string, string]> => [
  ...headers.flatMap(([name, value]): Array<[string, string]> => {
    const lower = name.toLowerCase();

    return lower === socketHeader || lower === pathHeader ? [] : [[name, value]];
  }),
  [socketHeader, `${secretOf(state)} ${id}`],
  [pathHeader, path],
];

/** The socket a request's headers name, as `socketHeaders` set them, or none for any other. */
export const socketOfHeaders = (state: DurableObjectState, headers: Headers.Headers) => {
  const [secret, id] = (headers[socketHeader] ?? "").split(" ");
  const path = headers[pathHeader];
  const socket = Number(id);

  return secret === secretOf(state) && Predicate.isString(path) && Number.isInteger(socket)
    ? Option.some({ socket, path })
    : Option.none();
};

const parser = RpcSerialization.json.makeUnsafe();

/**
 * Sends `frame` to the socket `id`: `true` when it went, `false` when no socket holds the id, or
 * the one that does refuses it, as one the object already closed does, which drops it.
 */
export const sendFrame = (
  state: DurableObjectState,
  id: number,
  frame: RpcMessage.FromServerEncoded,
) =>
  Effect.sync(() => {
    const sockets = state.getWebSockets(socketTag(id));
    const encoded = parser.encode(frame);

    if (sockets.length === 0 || encoded === undefined) return false;

    try {
      for (const socket of sockets) socket.send(encoded);
    } catch {
      return false;
    }

    return true;
  });
