import type * as ActionRpc from "@gjermundgaraba/effect-actions/ActionRpc";
import { Effect, Function, Match, Option, Predicate, Schema } from "effect";
import type { RpcMessage } from "effect/rpc";

import { deleted } from "./batches.js";
import { closeQuietly, groupTag, RequestId, socketIdOf } from "./frames.js";

export const keptPrefix = "effect-actions/subscription/";

const Request = Schema.TaggedStruct("Request", {
  id: RequestId,
  tag: Schema.String,
  headers: Schema.mutable(
    Schema.Array(Schema.mutable(Schema.Tuple([Schema.String, Schema.String])))
  ),
});

const requestOf = Schema.decodeUnknownOption(Request);

const payloadOf = Schema.decodeUnknownOption(Schema.Json);

const resumeFailedCode = 1000;

const unresumable =
  "This server could not resume this socket's subscriptions: connect again";

const suffixOf = (socket: number, id: string | number) =>
  `${socket}#${Predicate.isNumber(id) ? "n" : "s"}${id}`;

const socketOf = (suffix: string) =>
  Number(suffix.slice(0, suffix.indexOf("#")));

export const makeSubscriptions = (state: DurableObjectState, path: string) => {
  const { storage } = state;
  const group = groupTag(path);

  const requests = `${keptPrefix}request/${path}#`;
  const payloads = `${keptPrefix}payload/${path}#`;

  const keysOf = (suffix: string) => [
    `${requests}${suffix}`,
    `${payloads}${suffix}`,
  ];

  const liveSubscriptionsMirror = new Map<
    string,
    ActionRpc.KeptSubscription["resumeFrom"]
  >();

  const listed = (prefix: string) =>
    Effect.map(
      Effect.promise(async () => await storage.list({ prefix })),
      (found) =>
        [...found].map(
          ([key, value]) => [key.slice(prefix.length), value] as const
        )
    );

  const closed = (socket: number) =>
    Effect.suspend(() => {
      const owned = [...liveSubscriptionsMirror.keys()].filter(
        (suffix) => socketOf(suffix) === socket
      );

      for (const suffix of owned) {
        liveSubscriptionsMirror.delete(suffix);
      }

      return deleted(storage, owned.flatMap(keysOf));
    });

  const keeper: ActionRpc.SubscriptionKeeper = {
    keep: ({ clientId, requestId, tag, payload, headers, resumeFrom }) =>
      Effect.suspend(() => {
        const suffix = suffixOf(clientId, requestId);
        const resuming = liveSubscriptionsMirror.has(suffix);

        liveSubscriptionsMirror.set(suffix, resumeFrom);

        if (resuming) {
          return Effect.void;
        }

        return Effect.promise(async () => {
          await storage.put({
            [`${requests}${suffix}`]: Request.make({
              id: requestId,
              tag,
              headers: headers.map(([name, value]) => [name, value]),
            }),
            [`${payloads}${suffix}`]: payload,
          });
        });
      }),
  };

  const moved = (
    suffix: string,
    values: RpcMessage.ResponseChunkEncoded["values"]
  ) =>
    Effect.suspend(() => {
      const payload = liveSubscriptionsMirror.get(suffix)?.(values);

      return payload === undefined
        ? Effect.void
        : Effect.promise(async () => {
            await storage.put(`${payloads}${suffix}`, payload);
          });
    });

  const sent = (
    socket: number,
    response: RpcMessage.FromServerEncoded
  ): Effect.Effect<void> =>
    Match.value(response).pipe(
      Match.tag("Defect", () => closed(socket)),
      Match.tag("Chunk", ({ requestId, values }) =>
        moved(suffixOf(socket, requestId), values)
      ),
      Match.tag("Exit", ({ requestId }) =>
        Effect.suspend(() => {
          const suffix = suffixOf(socket, requestId);

          return liveSubscriptionsMirror.delete(suffix)
            ? Effect.promise(async () => await storage.delete(keysOf(suffix)))
            : Effect.void;
        })
      ),
      Match.orElse(() => Effect.void)
    );

  const unresumed = (socket: WebSocket) =>
    Effect.andThen(
      Effect.logWarning(
        `layerWebSocket at ${path} could not resume a socket's kept event subscriptions, and closes it`
      ),
      Effect.sync(() => {
        closeQuietly(socket, resumeFailedCode, unresumable);
      })
    );

  const resumed = (
    write: (
      socket: number,
      request: RpcMessage.FromClientEncoded
    ) => Effect.Effect<void>,
    held: (
      socket: WebSocket,
      kept: (requestId: string | number) => boolean
    ) => boolean
  ) =>
    Effect.gen(function* () {
      const kept = yield* listed(requests);
      const resumeFrom = new Map(yield* listed(payloads));
      const keptIds = new Set(kept.map(([suffix]) => suffix));

      const open = new Map<number, WebSocket>();

      for (const socket of state.getWebSockets(group)) {
        const id = socketIdOf(state.getTags(socket));

        if (held(socket, (requestId) => keptIds.has(suffixOf(id, requestId)))) {
          open.set(id, socket);
        }
      }

      const entries = kept.map(([suffix, value]) => ({
        suffix,
        socket: socketOf(suffix),
        request: Option.zipWith(
          requestOf(value),
          payloadOf(resumeFrom.get(suffix)),
          (request, payload) => ({ ...request, payload })
        ),
      }));

      const unread = new Set(
        entries.flatMap(({ socket, request }) =>
          open.has(socket) && Option.isNone(request) ? [socket] : []
        )
      );

      const gone = [...resumeFrom.keys()].flatMap((suffix) =>
        keptIds.has(suffix) ? [] : [`${payloads}${suffix}`]
      );

      for (const { suffix, socket, request } of entries) {
        if (open.has(socket) && !unread.has(socket) && Option.isSome(request)) {
          liveSubscriptionsMirror.set(suffix, Function.constUndefined);

          yield* write(socket, request.value);
        } else {
          gone.push(...keysOf(suffix));
        }
      }

      yield* deleted(storage, gone);

      for (const [id, socket] of open) {
        if (unread.has(id)) {
          yield* unresumed(socket);
        }
      }
    });

  return { keeper, sent, closed, resumed };
};
