import * as ActionHttp from "../src/ActionHttp.js";
import { Forbidden, Unauthenticated } from "./auth.js";
import {
  Double,
  GetUser,
  InternalError,
  InvalidRequest,
  RenameUser,
  Status,
  WhoAmI,
} from "./contracts.js";

// Contract-level: the server and its clients share it, and it is plain data, so a
// browser client importing it bundles no server code. The binding declares the failures
// the surface itself answers with, so a typed client decodes the 401 from
// authentication middleware, the 403 from the authorization hook, and the answers to
// malformed requests and unencodable results instead of reporting a decode error. No
// handler can return any of them. `ListChanges` is a tool for agents reviewing what
// happened, so HTTP leaves it out.
export const Http = ActionHttp.make([Status, GetUser, RenameUser, Double, WhoAmI], {
  errors: [Unauthenticated, Forbidden, InvalidRequest, InternalError],
  schemaError: {
    invalid: () =>
      new InvalidRequest({ message: "The request does not match the action's input." }),
    internal: () => new InternalError({ message: "The request could not be completed." }),
  },
});
