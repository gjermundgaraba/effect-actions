import { Schema } from "effect";
import * as Action from "../src/Action.js";
import * as ActionGroup from "../src/ActionGroup.js";
import * as ActionHttp from "../src/ActionHttp.js";
import type { HttpApiError } from "effect/unstable/httpapi";
import { Forbidden, Unauthenticated } from "./auth.js";

export const User = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
});

export class UserNotFound extends Schema.TaggedError<UserNotFound>()(
  "UserNotFound",
  { id: Schema.String },
  { httpApiStatus: 404 },
) {}

export class InvalidRequest extends Schema.TaggedError<InvalidRequest>()(
  "InvalidRequest",
  { message: Schema.String },
  { httpApiStatus: 400 },
) {}

export class InternalError extends Schema.TaggedError<InternalError>()(
  "InternalError",
  { message: Schema.String },
  { httpApiStatus: 500 },
) {}

// Reachable without credentials: it must work before anyone has signed in.
export const Status = Action.make("status", {
  description: "Report whether the service is up.",
  success: Schema.Struct({ service: Schema.String, users: Schema.Finite }),
  access: "read",
});

export const GetUser = Action.make("getUser", {
  description: "Look up a user in your tenant.",
  input: Schema.Struct({ id: Schema.String }),
  success: User,
  errors: [UserNotFound],
  access: "read",
  mcp: { name: "get_user" },
});

export const RenameUser = Action.make("renameUser", {
  description: "Rename a user in your tenant.",
  input: Schema.Struct({
    id: Schema.String,
    name: Schema.String.check(Schema.isMinLength(1)),
  }),
  success: User,
  errors: [UserNotFound],
  access: "write",
  mcp: { name: "rename_user", destructive: false },
});

// On either transport, input is { value: "21" }. The handler receives numeric 21.
export const Double = Action.make("double", {
  description: "Double a finite number supplied as a string.",
  input: Schema.Struct({ value: Schema.FiniteFromString }),
  success: Schema.Finite,
  access: "read",
});

// Identity comes from the host's authenticated request context, not action input.
export const WhoAmI = Action.make("whoAmI", {
  description: "Inspect the authenticated actor.",
  success: Schema.Struct({ id: Schema.String, tenantId: Schema.String }),
  access: "read",
});

export const Change = Schema.Struct({
  actorId: Schema.String,
  userId: Schema.String,
  name: Schema.String,
});

// A tool for agents reviewing what happened, not part of the HTTP API.
export const ListChanges = Action.make("listChanges", {
  description: "List the renames made in your tenant, oldest first.",
  success: Schema.Struct({ changes: Schema.Array(Change) }),
  access: "read",
  http: false,
  mcp: { name: "list_changes" },
});

// Malformed requests and unencodable results get one typed answer over HTTP.
const schemaError = {
  errors: [InvalidRequest, InternalError],
  map: ({ kind }: HttpApiError.HttpApiSchemaError) =>
    kind === "Body" || kind === "ResponseHeaders"
      ? new InternalError({ message: "The request could not be completed." })
      : new InvalidRequest({ message: "The request does not match the action's input." }),
};

// One group per access rule: the host mounts each under its own middleware.
export const PublicActions = ActionGroup.make({ name: "public", schemaError }, Status);

// Every authorized action can be refused, so the group declares that once.
export const UserActions = ActionGroup.make(
  { name: "users", errors: [Forbidden], schemaError },
  GetUser,
  RenameUser,
  Double,
  WhoAmI,
);

export const AuditActions = ActionGroup.make(
  { name: "audit", errors: [Forbidden], schemaError },
  ListChanges,
);

// Contract-level: the server and its clients share the mount path, and the
// failures the surface itself answers with, so a typed client decodes a 401
// from authentication middleware instead of reporting a decode error.
export const Http = ActionHttp.make(
  { apiPath: "/api/actions", errors: [Unauthenticated] },
  PublicActions,
  UserActions,
  AuditActions,
);
