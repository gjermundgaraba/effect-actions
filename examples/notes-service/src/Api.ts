import * as ActionHttp from "@gjermundgaraba/effect-actions/ActionHttp";

import { Login, WhoAmI } from "./identity/Identity.js";
import { Notes } from "./notes/Notes.js";
import { GetStatus } from "./status/Status.js";

export const Http = ActionHttp.make([GetStatus, ...Notes, WhoAmI], {
  prefix: "/api",
  authentication: Login,
});
