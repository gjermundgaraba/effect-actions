import * as ActionHttp from "@gjermundgaraba/effect-actions/ActionHttp";

import { Greet } from "./greeting/Greeting.js";

export const Http = ActionHttp.make([Greet]);
