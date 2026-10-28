import * as ActionRpc from "@gjermundgaraba/effect-actions/ActionRpc";
import { Layer } from "effect";

import { messageEvents } from "./chat/events.js";
import { messages, rooms } from "./chat/handlers.js";
import { ResolveRoom, resolveRoom } from "./chat/room.js";
import { authenticate } from "./identity/verifier.js";
import { Rpc } from "./Rpc.js";

export const rpc = ActionRpc.layer(Rpc, [rooms, messages, messageEvents], {
  middleware: [ResolveRoom],
}).pipe(Layer.provide([resolveRoom, authenticate]));
