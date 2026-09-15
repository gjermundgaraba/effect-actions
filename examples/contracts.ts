import { Schema } from "effect";
import { Action, ActionGroup } from "../src/index.js";
import { Forbidden } from "./auth.js";

export const User = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
});

export class UserNotFound extends Schema.TaggedError<UserNotFound>()(
  "UserNotFound",
  { id: Schema.String },
  { httpApiStatus: 404 },
) {}

export const GetUser = Action.make("getUser", {
  description: "Look up a user in your tenant.",
  input: Schema.Struct({ id: Schema.String }),
  success: User,
  error: [UserNotFound, Forbidden],
  mcp: { name: "get_user", readOnly: true },
});

export const RenameUser = Action.make("renameUser", {
  description: "Rename a user in your tenant.",
  input: Schema.Struct({
    id: Schema.String,
    name: Schema.String.check(Schema.isMinLength(1)),
  }),
  success: User,
  error: [UserNotFound, Forbidden],
  mcp: { name: "rename_user", destructive: false },
});

// On either transport, input is { value: "21" }. The handler receives numeric 21.
export const Double = Action.make("double", {
  description: "Double a finite number supplied as a string.",
  input: Schema.Struct({ value: Schema.FiniteFromString }),
  success: Schema.Finite,
  mcp: { readOnly: true },
});

// Identity comes from the host's authenticated request context, not action input.
export const WhoAmI = Action.make("whoAmI", {
  description: "Inspect the authenticated actor.",
  success: Schema.Struct({ id: Schema.String, tenantId: Schema.String }),
  mcp: { readOnly: true },
});

export const Actions = ActionGroup.make(GetUser, RenameUser, Double, WhoAmI);
