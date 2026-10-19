import { Effect } from "effect";
import * as Action from "@gjermundgaraba/effect-actions/Action";
import { RoomName } from "../chat/Chat.js";
import { Previews } from "./Lobby.js";
import { Rooms } from "./rooms.js";

export const lobby = Action.implement(
  Previews,
  Effect.gen(function* () {
    const rooms = yield* Rooms;

    // The rooms are asked at once: each is another object, possibly on another machine.
    return () =>
      Effect.forEach(
        RoomName.literals,
        (room) => Effect.map(rooms.latestAt(room), (latestAt) => ({ room, latestAt })),
        { concurrency: "unbounded" },
      ).pipe(Effect.map((previews) => ({ previews })));
  }),
);
