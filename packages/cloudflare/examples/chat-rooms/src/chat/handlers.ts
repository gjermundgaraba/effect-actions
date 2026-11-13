import * as Action from "@gjermundgaraba/effect-actions/Action";
import * as Event from "@gjermundgaraba/effect-actions/Event";
import { Clock, Effect, Schedule } from "effect";
import type { Entity } from "effect/cluster";
import type { RpcGroup } from "effect/rpc";

import { CurrentMember } from "../identity/Identity.js";
import { LobbyClient } from "../lobby/client.js";
import { authorize } from "./authorize.js";
import { MessagePosted, Messages } from "./Chat.js";
import { RoomMailbox } from "./mailbox.js";
import { Room } from "./room.js";
import { MessageStore } from "./store.js";
import { day, windowOf } from "./Tells.js";
import type { RoomTells } from "./Tells.js";

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

          return yield* store.post(
            member.id,
            text,
            at,
            events.notify(MessagePosted)
          );
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

const retried = <A, E, R>(work: Effect.Effect<A, E, R>) =>
  work.pipe(
    Effect.sandbox,
    Effect.retry({ schedule: Schedule.exponential("100 millis"), times: 2 }),
    Effect.catch(Effect.failCause)
  );

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

  const askLobby = Effect.flatMap(store.latest, ({ at, version }) =>
    lobby.roomChanged({ preview: { room, latestAt: at }, version })
  );

  return {
    expire: ({ payload: { at } }) =>
      expire(at).pipe(
        retried,
        Effect.ignoreCause({
          log: "Warn",
          message: "Expiring the room's day-old messages failed",
        })
      ),
    tellLobby: () =>
      askLobby.pipe(
        retried,
        Effect.timeout(lobbyAnswersWithin),
        Effect.ignoreCause({
          log: "Warn",
          message: "Telling the lobby the room changed failed",
        })
      ),
  } satisfies Entity.HandlersFrom<RpcGroup.Rpcs<typeof RoomTells>>;
});
