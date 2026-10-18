import { Effect } from "effect";
import * as Action from "@gjermundgaraba/effect-actions/Action";
import { Previews } from "./Lobby.js";
import { Rooms } from "./rooms.js";

export const lobby = Action.implement(
  Previews,
  Effect.gen(function* () {
    const rooms = yield* Rooms;

    // The rooms are asked at once: each is another object, possibly on another machine.
    return ({ rooms: names }) =>
      Effect.forEach(
        names,
        (room) => Effect.map(rooms.latest(room), (latest) => ({ room, latest })),
        { concurrency: "unbounded" },
      ).pipe(Effect.map((previews) => ({ previews })));
  }),
);
