import * as ActionHttp from "../src/ActionHttp.js";
import { Double, GetUser, RenameUser, Status, WhoAmI } from "./contracts.js";

// Contract-level: the server and its clients share it, and it is plain data, so a
// browser client importing it bundles no server code. Every endpoint also declares the
// built-in `InvalidInput`, `Unauthenticated` and `Forbidden`, so a typed client decodes
// a malformed request, the authentication middleware's 401 and the authorization hook's
// 403 instead of reporting a decode error. `ListChanges` is a tool for agents reviewing
// what happened, so HTTP leaves it out.
export const Http = ActionHttp.make([Status, GetUser, RenameUser, Double, WhoAmI]);
