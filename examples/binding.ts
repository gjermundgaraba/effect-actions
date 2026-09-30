import { HttpApiSecurity } from "effect/http-api";
import * as ActionHttp from "../src/ActionHttp.js";
import { Double, GetUser, RenameUser, Status, WhoAmI } from "./contracts.js";

// Contract-level: the server and its clients share it, and it is plain data. Every
// endpoint also declares the built-in `InvalidInput`, `Unauthenticated` and `Forbidden`,
// so a typed client decodes a malformed request, the authentication's 401 and the
// authorization hook's 403 instead of reporting a decode error. `ListChanges` is a tool
// for agents reviewing what happened, so HTTP leaves it out.
export const Http = ActionHttp.make([Status, GetUser, RenameUser, Double, WhoAmI], {
  // For the OpenAPI document: the credential the authentication around the routes reads,
  // stated on every endpoint but the public `status`'s. It enforces nothing: the
  // authentication provided around a layer does.
  security: { bearer: HttpApiSecurity.bearer },
  public: [Status],
});
