import * as ActionHttp from "@gjermundgaraba/effect-actions/ActionHttp";

import { Greet } from "./greeting/Greeting.js";

// The HTTP binding: `POST /api/greet`. The server serves it and the client calls it.
export const Http = ActionHttp.make([Greet]);
