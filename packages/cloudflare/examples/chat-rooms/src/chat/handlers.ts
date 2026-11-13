import * as Action from "@gjermundgaraba/effect-actions/Action";
import * as Event from "@gjermundgaraba/effect-actions/Event";
import { Clock, Effect } from "effect";
import type { Entity } from "effect/cluster";
import type { RpcGroup } from "effect/rpc";

import { CurrentMember } from "../identity/Identity.js";
import { LobbyClient } from "../lobby/client.js";
import { retryLater } from "../retry.js";
import { authorize } from "./authorize.js";
import { MessagePosted, Messages } from "./Chat.js";
import { RoomMailbox } from "./mailbox.js";
import { Room } from "./room.js";
import { MessageStore } from "./store.js";
import { day, windowOf } from "./Tells.js";
import type { RoomTells, Task } from "./Tells.js";

export const messages = Action.implement(
  Messages,
  Effect.gen(function* () {
    const store = yield* MessageStore;
    const events = yield* Event.Events;
    const mailbox = yield* RoomMailbox;

    const followUpsRunAfterThisCall = Effect.fnUntraced(function* (at: number) {
      const latest = yield* store.latest;

      if (latest.at === null || windowOf(latest.at) !== windowOf(at)) {
        yield* mailbox.expire(windowOf(at));
      }

      yield* mailbox.tellLobby;
    });

    return {
      readMessages: ({ after }) =>
        Effect.map(store.read(after), (read) => ({ messages: read })),
      postMessage: ({ text }) =>
        Effect.gen(function* () {
          const member = yield* CurrentMember;
          const at = yield* Clock.currentTimeMillis;

          yield* followUpsRunAfterThisCall(at);

          const message = yield* store.post(member.id, text, at);

          yield* events.notify(MessagePosted);

          return message;
        }),
      deleteMessage: ({ id }) =>
        Effect.andThen(
          mailbox.tellLobby,
          Effect.flatMap(CurrentMember, (member) => store.remove(member.id, id))
        ),
    };
  }),
  { authorize }
);

const lobbyAnswersWithin = "1 second";

const described = {
  expire: "Expiring the room's day-old messages",
  tellLobby: "Telling the lobby the room changed",
} satisfies Record<Task, string>;

export const roomTells = Effect.gen(function* () {
  const room = yield* Room;
  const store = yield* MessageStore;
  const lobby = yield* LobbyClient;
  const mailbox = yield* RoomMailbox;

  const expire = (at: number) =>
    Effect.gen(function* () {
      yield* mailbox.tellLobby;
      yield* store.expire(at - day);

      const oldest = yield* store.oldest;

      if (oldest !== null) {
        yield* mailbox.expire(windowOf(oldest.at));
      }
    });

  const retrying = (task: Task, attempt: number) =>
    retryLater(described[task], attempt, (at) =>
      mailbox.retry(task, at, attempt + 1)
    );

  const askLobby = (attempt: number) =>
    Effect.flatMap(store.latest, ({ at, version }) =>
      lobby
        .roomChanged({ preview: { room, latestAt: at }, version })
        .pipe(Effect.timeout(lobbyAnswersWithin))
    ).pipe(retrying("tellLobby", attempt));

  return {
    expire: ({ payload: { at } }) => expire(at).pipe(retrying("expire", 0)),
    tellLobby: () => askLobby(0),
    retry: ({ payload: { task, at, attempt } }) =>
      task === "expire"
        ? expire(at).pipe(retrying(task, attempt))
        : askLobby(attempt),
  } satisfies Entity.HandlersFrom<RpcGroup.Rpcs<typeof RoomTells>>;
});
