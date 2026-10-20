import { Effect, Schema } from "effect";

// Why: one tag per socket, across every protocol of the object, so a socket id alone, as a
// subscriber's record keeps it, finds its socket after hibernation, whichever path accepted it.
const socketPrefix = "effect-actions/socket#";

/** The tag a socket carries for its id, unique among the object's sockets. */
export const socketTag = (id: number) => `${socketPrefix}${id}`;

/** The id a socket's tags give it, or `undefined` for one no protocol accepted. */
export const socketIdOf = (tags: ReadonlyArray<string>): number | undefined => {
  const tag = tags.find((found) => found.startsWith(socketPrefix));

  return tag === undefined ? undefined : Number(tag.slice(socketPrefix.length));
};

/** The storage key holding the next socket id, so no id names two sockets. */
export const nextSocketKey = "effect-actions/socket/next";

const recordPrefix = "effect-actions/feed/";

const ofSocket = (socket: number) => `${recordPrefix}${socket}/`;

/** The storage key of the subscription `request` on the socket `socket`. */
export const recordKey = (socket: number, request: string) => `${ofSocket(socket)}${request}`;

/**
 * A subscription, as storage keeps it: its rpc's tag, the key it was given, and its request's
 * id as the client sent it, a number or a string, which the client finds its call by.
 */
export const Subscription = Schema.Struct({
  tag: Schema.String,
  key: Schema.UndefinedOr(Schema.String),
  requestId: Schema.Union([Schema.String, Schema.Number]),
});

export type Subscription = typeof Subscription.Type;

/** The socket a record's key names, or `undefined` for a key no record has. */
export const socketOfRecord = (storageKey: string) => {
  const socket = Number(storageKey.slice(recordPrefix.length).split("/")[0]);

  return Number.isInteger(socket) ? socket : undefined;
};

/** Every subscription's record in `storage`, by its storage key. */
export const records = (storage: DurableObjectStorage) =>
  Effect.promise(() => storage.list({ prefix: recordPrefix }));

/** Drops the record of `request` on `socket`, or, without `request`, all of the socket's. */
export const forget = (storage: DurableObjectStorage, socket: number, request?: string) =>
  Effect.promise(async () => {
    if (request !== undefined) {
      await storage.delete(recordKey(socket, request));

      return;
    }

    const keys = [...(await storage.list({ prefix: ofSocket(socket) })).keys()];

    // Why: the runtime deletes at most 128 keys in one call.
    for (let start = 0; start < keys.length; start += 128) {
      await storage.delete(keys.slice(start, start + 128));
    }
  });
