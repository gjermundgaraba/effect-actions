import * as ActionHttp from "@gjermundgaraba/effect-actions/ActionHttp";
import { Login, WhoAmI } from "./identity/Identity.js";
import { Notes } from "./notes/Notes.js";
import { GetStatus } from "./status/Status.js";

// The HTTP binding: every action at `POST /api/<name>`, the protected ones requiring `Login`.
// It is plain data and imports no server code, so the server, the CLI and a browser page all
// import this one value, and each gets its routes or its typed methods from it. An action
// added here is also a `notes` command: commands.ts derives one per action of this binding.
export const Http = ActionHttp.make([GetStatus, ...Notes, WhoAmI], {
  prefix: "/api",
  authentication: Login,
});
