import { Context } from "effect";

import type { DemoRoomName } from "./Chat.js";

export class Room extends Context.Service<Room, DemoRoomName>()(
  "chat-rooms/Room"
) {}
