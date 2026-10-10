import { Schema } from "effect";
import * as Action from "@gjermundgaraba/effect-actions/Action";
import { CurrentActor } from "./authorization.js";

export const User = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
});

export class UserNotFound extends Schema.TaggedError<UserNotFound>()(
  "UserNotFound",
  { id: Schema.String },
  { httpApiStatus: 404 },
) {}

// Reachable without credentials: it must work before anyone has signed in.
export const Status = Action.make("status", {
  description: "Report whether the service is up.",
  success: { service: Schema.String, users: Schema.Finite },
  readOnly: true,
  caller: Action.Anyone,
});

export const GetUser = Action.make("getUser", {
  description: "Look up a user in your tenant.",
  input: { id: Schema.String },
  success: User,
  error: UserNotFound,
  readOnly: true,
  caller: CurrentActor,
});

export const RenameUser = Action.make("renameUser", {
  description: "Rename a user in your tenant.",
  input: {
    id: Schema.String,
    name: Schema.String.check(Schema.isMinLength(1)),
  },
  success: User,
  error: UserNotFound,
  readOnly: false,
  caller: CurrentActor,
  mcp: { destructiveHint: false },
});

// On either transport, input is { value: "21" }. The handler receives numeric 21.
export const Double = Action.make("double", {
  description: "Double a finite number supplied as a string.",
  input: { value: Schema.FiniteFromString },
  success: Schema.Finite,
  readOnly: true,
  caller: CurrentActor,
});

// Identity comes from the host's authenticated request context, not action input.
export const WhoAmI = Action.make("whoAmI", {
  description: "Inspect the authenticated actor.",
  success: { id: Schema.String, tenantId: Schema.String },
  readOnly: true,
  caller: CurrentActor,
});

export const Change = Schema.Struct({
  actorId: Schema.String,
  userId: Schema.String,
  name: Schema.String,
});

export const ListChanges = Action.make("listChanges", {
  description: "List the renames made in your tenant, oldest first.",
  success: { changes: Schema.Array(Change) },
  readOnly: true,
  caller: CurrentActor,
});
