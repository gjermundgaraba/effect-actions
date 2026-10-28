import * as Event from "@gjermundgaraba/effect-actions/Event";
import { Effect, Stream, Struct } from "effect";

import { authorize } from "../identity/authorize.js";
import { CurrentMember } from "../identity/Identity.js";
import { IssueChanged } from "./Issues.js";
import { IssueStore } from "./store.js";

export const issueEvents = Event.implement(
  IssueChanged,
  Effect.gen(function* () {
    const store = yield* IssueStore;

    return {
      log: {
        emit: Stream.map(store.changes, (data) => ({
          data,
          key: data.workspace,
        })),
        maxAge: "1 hour",
        maxEvents: 1000,
      },
      key: (): Effect.Effect<string, never, CurrentMember> =>
        Effect.map(CurrentMember, (member) => member.workspace),
      match: ({ status }, change) =>
        status === undefined || change.status === status,
      transform: ({ comments }, change) =>
        comments === false ? Struct.omit(change, ["comment"]) : change,
    };
  }),
  { authorize }
);
