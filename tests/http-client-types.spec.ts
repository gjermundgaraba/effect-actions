// Compile-only Promise client assertions, included by `vp check`.
import { type DateTime, type Effect, Schema } from "effect";
import * as Action from "../src/Action.js";
import * as ActionGroup from "../src/ActionGroup.js";
import * as ActionHttp from "../src/ActionHttp.js";
import * as ActionHttpClient from "../src/ActionHttpClient.js";

const Notes = ActionGroup.make(
  { name: "notes" },
  Action.make("get", {
    description: "Read a note",
    access: "read",
    input: Schema.Struct({ id: Schema.String }),
    success: Schema.Struct({ id: Schema.String, at: Schema.DateTimeUtcFromString }),
  }),
  Action.make("list", {
    description: "List notes",
    access: "read",
    input: Schema.Struct({ limit: Schema.optionalKey(Schema.Finite) }),
    success: Schema.Array(Schema.String),
  }),
  Action.make("count", { description: "Count notes", access: "read", success: Schema.Finite }),
);

const client = ActionHttpClient.promise(ActionHttp.make({ apiPath: "/api" }, Notes));

export const decodedSuccess: Promise<{ readonly id: string; readonly at: DateTime.Utc }> =
  client.notes.get({ id: "a" });

export const optionalInput: Promise<ReadonlyArray<string>> = client.notes.list();

export const noInput: Promise<number> = client.notes.count();

export const promiseClientTypes = () => {
  // @ts-expect-error Input is typed by the action.
  void client.notes.get({ id: 1 });
  // @ts-expect-error An action with required input needs its argument.
  void client.notes.get();

  ActionHttpClient.promise(ActionHttp.make({ apiPath: "/api" }, Notes), {
    // @ts-expect-error A response transform could change what a method resolves with.
    transformResponse: (effect: Effect.Effect<unknown, unknown, unknown>) => effect,
  });

  // @ts-expect-error The success is the decoded type, not its JSON encoding.
  const encoded: Promise<{ readonly id: string; readonly at: string }> = client.notes.get({
    id: "a",
  });

  return encoded;
};
