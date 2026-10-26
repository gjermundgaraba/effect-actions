import { Effect, Match, Option, Predicate, Schema } from "effect";
import type { RpcMessage } from "effect/rpc";
import type * as ActionRpc from "@gjermundgaraba/effect-actions/ActionRpc";
import { batches } from "./batches.js";
import { closeQuietly, groupTag, RequestId, socketIdOf } from "./frames.js";

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
 * `resumed` writes each kept one whose socket of this path is still open to the server again,
 * from there.
 */
export const makeSubscriptions = (state: DurableObjectState, path: string) => {
  const storage = state.storage;
  const group = groupTag(path);

  // Why: the request, its headers included, is written once, as it is admitted, and only the
  // payload it resumes from is written again as the subscription moves.
  const requests = `${keptPrefix}request/${path}#`;
  const payloads = `${keptPrefix}payload/${path}#`;

  // Why: Effect's request id is a number or a string, `1` and `"1"` two ids, so the key says which.
  const suffixOf = (socket: number, id: string | number) =>
    `${socket}#${Predicate.isNumber(id) ? "n" : "s"}${id}`;

  const keysOf = (suffix: string) => [`${requests}${suffix}`, `${payloads}${suffix}`];
  const socketOf = (suffix: string) => Number(suffix.slice(0, suffix.indexOf("#")));

  // Why: once `resumed` has run, as the build making the protocol runs it, storage holds this
  // path's subscriptions exactly as this map does, every other one resumed or forgotten, so a
  // close forgets a socket's from it, listing nothing: a socket that never subscribed costs no
  // storage call.
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
    Effect.suspend(() => {
      const owned = [...live.keys()].filter((suffix) => socketOf(suffix) === socket);

      for (const suffix of owned) live.delete(suffix);

      return deleted(owned.flatMap(keysOf));
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
  const unresumed = (socket: WebSocket) =>
    Effect.andThen(
      Effect.logWarning(
        `layerWebSocket at ${path} could not resume a socket's kept event subscriptions, and closes it`,
      ),
      Effect.sync(() => closeQuietly(socket, 1000, unresumable)),
    );

  /**
   * Writes each kept subscription of a socket of this path still open to the server, from where
   * it reached, and forgets the rest: `held` answers whether a socket stays open, given whether
   * one of its requests is a subscription kept for it, and closes one that does not.
   */
  const resumed = (
    write: (socket: number, request: RpcMessage.FromClientEncoded) => Effect.Effect<void>,
    held: (socket: WebSocket, kept: (requestId: string | number) => boolean) => boolean,
  ) =>
    Effect.gen(function* () {
      const kept = yield* listed(requests);
      const resumeFrom = new Map(yield* listed(payloads));
      const keptIds = new Set(kept.map(([suffix]) => suffix));

      // Why: matched by the path's group as well as the socket's id, as a socket's id is unique
      // only among the sockets open, so a subscription this path kept while it was not served,
      // such as across a deployment that dropped it, never resumes on another path's socket given
      // that id since, authenticated with its first caller's headers.
      const open = new Map<number, WebSocket>();

      for (const socket of state.getWebSockets(group)) {
        const id = socketIdOf(state.getTags(socket));

        if (held(socket, (requestId) => keptIds.has(suffixOf(id, requestId)))) open.set(id, socket);
      }

      const entries = kept.map(([suffix, value]) => ({
        suffix,
        socket: socketOf(suffix),
        request: Option.zipWith(
          requestOf(value),
          payloadOf(resumeFrom.get(suffix)),
          (request, payload) => ({ ...request, payload }),
        ),
      }));

      const unread = new Set(
        entries.flatMap(({ socket, request }) =>
          open.has(socket) && Option.isNone(request) ? [socket] : [],
        ),
      );

      const gone = [...resumeFrom.keys()]
        .filter((suffix) => !keptIds.has(suffix))
        .map((suffix) => `${payloads}${suffix}`);

      for (const { suffix, socket, request } of entries) {
        if (open.has(socket) && !unread.has(socket) && Option.isSome(request)) {
          live.set(suffix, () => undefined);

          yield* write(socket, request.value);
        } else {
          gone.push(...keysOf(suffix));
        }
      }

      yield* deleted(gone);

      for (const [id, socket] of open) if (unread.has(id)) yield* unresumed(socket);
    });

  return { keeper, sent, closed, resumed };
};
