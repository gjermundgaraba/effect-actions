import { Effect, Match, Option, Predicate, Schema } from "effect";
import type { RpcMessage } from "effect/rpc";
import type * as ActionRpc from "@gjermundgaraba/effect-actions/ActionRpc";
import { batches } from "./batches.js";
import { closeQuietly, RequestId, socketTag } from "./frames.js";

/** Where an object keeps its sockets' event subscriptions. */
const keptPrefix = "effect-actions/subscription/";

const Request = Schema.TaggedStruct("Request", {
  id: RequestId,
  tag: Schema.String,
  headers: Schema.mutable(
    Schema.Array(Schema.mutable(Schema.Tuple([Schema.String, Schema.String]))),
  ),
});

const requestOf = Schema.decodeUnknownOption(Request);

const payloadOf = Schema.decodeUnknownOption(Schema.Json);

const unresumable = "This server could not resume this socket's subscriptions: connect again";

/**
 * The event subscriptions of the sockets one `layerWebSocket` path accepted, kept in storage:
 * `keeper` stores each request as `ActionRpc.layer` admits it, `sent` stores the payload that
 * resumes it with each chunk sent and forgets it at its exit, `closed` forgets a socket's, and
 * `resumed` writes each kept one whose socket is still open to the server again, from there.
 */
export const makeSubscriptions = (state: DurableObjectState, path: string) => {
  const storage = state.storage;

  // Why: the request, its headers included, is written once, as it is admitted, and only the
  // payload it resumes from is written again as the subscription moves.
  const requests = `${keptPrefix}request/${path}#`;
  const payloads = `${keptPrefix}payload/${path}#`;

  // Why: Effect's request id is a number or a string, `1` and `"1"` two ids, so the key says which.
  const suffixOf = (socket: number, id: string | number) =>
    `${socket}#${Predicate.isNumber(id) ? "n" : "s"}${id}`;

  const keysOf = (suffix: string) => [`${requests}${suffix}`, `${payloads}${suffix}`];
  const socketOf = (suffix: string) => Number(suffix.slice(0, suffix.indexOf("#")));

  const live = new Map<string, ActionRpc.KeptSubscription["resumeFrom"]>();

  const deleted = (keys: ReadonlyArray<string>) =>
    Effect.forEach(batches(keys), (batch) => Effect.promise(() => storage.delete([...batch])), {
      discard: true,
    });

  const listed = (prefix: string) =>
    Effect.map(
      Effect.promise(() => storage.list<unknown>({ prefix })),
      (found) => [...found].map(([key, value]) => [key.slice(prefix.length), value] as const),
    );

  const closed = (socket: number) =>
    Effect.gen(function* () {
      const owned = `${socket}#`;

      for (const suffix of live.keys()) if (suffix.startsWith(owned)) live.delete(suffix);

      const keys = [
        ...(yield* listed(`${requests}${owned}`)).map(([rest]) => `${requests}${owned}${rest}`),
        ...(yield* listed(`${payloads}${owned}`)).map(([rest]) => `${payloads}${owned}${rest}`),
      ];

      yield* deleted(keys);
    });

  const keeper: ActionRpc.SubscriptionKeeper = {
    keep: ({ clientId, requestId, tag, payload, headers, resumeFrom }) =>
      Effect.suspend(() => {
        const suffix = suffixOf(clientId, requestId);
        const resuming = live.has(suffix);

        live.set(suffix, resumeFrom);

        // Why: a request `resumed` wrote is stored as it is, its payload the one it resumed from.
        if (resuming) return Effect.void;

        return Effect.promise(() =>
          storage.put({
            [`${requests}${suffix}`]: Request.make({
              id: requestId,
              tag,
              headers: headers.map(([name, value]) => [name, value]),
            }),
            [`${payloads}${suffix}`]: payload,
          }),
        );
      }),
  };

  const moved = (suffix: string, values: RpcMessage.ResponseChunkEncoded["values"]) =>
    Effect.suspend(() => {
      const payload = live.get(suffix)?.(values);

      return payload === undefined
        ? Effect.void
        : Effect.promise(() => storage.put(`${payloads}${suffix}`, payload));
    });

  const sent = (socket: number, response: RpcMessage.FromServerEncoded): Effect.Effect<void> =>
    Match.value(response).pipe(
      Match.tag("Defect", () => closed(socket)),
      Match.tag("Chunk", ({ requestId, values }) => moved(suffixOf(socket, requestId), values)),
      Match.tag("Exit", ({ requestId }) =>
        Effect.suspend(() => {
          const suffix = suffixOf(socket, requestId);

          return live.delete(suffix)
            ? Effect.promise(() => storage.delete(keysOf(suffix)))
            : Effect.void;
        }),
      ),
      Match.orElse(() => Effect.void),
    );

  // Why: a kept subscription that cannot be resumed, such as one a later version of this package
  // stores in another shape, would leave its watch waiting on an open socket for good, since the
  // runtime answers its pings: the socket is closed with 1000, outside the codes a watch ends at,
  // so the page connects again and subscribes anew.
  const unresumed = (socket: number) =>
    Effect.andThen(
      Effect.logWarning(
        `layerWebSocket at ${path} could not resume a socket's kept event subscriptions, and closes it`,
      ),
      Effect.andThen(
        closed(socket),
        Effect.sync(() => {
          for (const held of state.getWebSockets(socketTag(socket))) {
            closeQuietly(held, 1000, unresumable);
          }
        }),
      ),
    );

  const resumed = (
    write: (socket: number, request: RpcMessage.FromClientEncoded) => Effect.Effect<void>,
  ) =>
    Effect.gen(function* () {
      const kept = yield* listed(requests);
      const resumeFrom = new Map(yield* listed(payloads));
      const unread = new Set<number>();
      const gone: Array<string> = [];

      for (const [suffix, value] of kept) {
        const socket = socketOf(suffix);
        const request = requestOf(value);
        const payload = payloadOf(resumeFrom.get(suffix));

        resumeFrom.delete(suffix);

        if (state.getWebSockets(socketTag(socket)).length === 0) {
          gone.push(...keysOf(suffix));
        } else if (Option.isNone(request) || Option.isNone(payload)) {
          unread.add(socket);
        } else {
          live.set(suffix, () => undefined);

          yield* write(socket, { ...request.value, payload: payload.value });
        }
      }

      gone.push(...[...resumeFrom.keys()].map((suffix) => `${payloads}${suffix}`));

      yield* deleted(gone);

      for (const socket of unread) yield* unresumed(socket);
    });

  /** Whether every one of `ids`, requests the socket sent, is a subscription kept for it. */
  const allKept = (socket: number, ids: ReadonlyArray<string | number>) =>
    Effect.map(listed(`${requests}${socket}#`), (found) => {
      const kept = new Set(found.map(([rest]) => `${socket}#${rest}`));

      return ids.every((id) => kept.has(suffixOf(socket, id)));
    });

  return { keeper, sent, closed, resumed, allKept };
};
