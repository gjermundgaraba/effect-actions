import * as Event from "@gjermundgaraba/effect-actions/Event";
import { Effect, Stream, Struct } from "effect";

import { authorize } from "../identity/authorize.js";
import { CurrentMember } from "../identity/Identity.js";
import { IssueChanged } from "./Issues.js";
import { IssueStore } from "./store.js";

// A log source fed by a stream: the store pushes every change, of every workspace, and the
// library consumes the stream once, from startup, keeping what it produced lately for
// subscribers resuming from a cursor. `key`, `match` and `transform` run per subscriber, as the
// subscriber.
export const issueEvents = Event.implement(
  IssueChanged,
  Effect.gen(function* () {
    const store = yield* IssueStore;

    return {
      log: {
        // No `eventId`: the library gives each change one, kept on every replay. An id of the
        // store's would have to stay unique across restarts, as a subscriber drops a repeated
        // one. Each change is keyed by its workspace, which reaches that workspace's
        // subscribers alone.
        emit: Stream.map(store.changes, (data) => ({
          data,
          key: data.workspace,
        })),
        // One log holds every workspace's changes: a subscriber resuming within an hour, and
        // within the last thousand changes of all workspaces, misses nothing; one resuming
        // later receives a gap first, then what is kept. A busy workspace shortens a quiet
        // one's hour.
        maxAge: "1 hour",
        maxEvents: 1000,
      },
      // Tenant isolation, as the store's methods hold it for the actions: a member follows
      // their own workspace's key. It is never `undefined`, which would follow every key.
      key: () => Effect.map(CurrentMember, (member) => member.workspace),
      match: ({ status }, change) =>
        status === undefined || change.status === status,
      transform: ({ comments }, change) =>
        comments === false ? Struct.omit(change, ["comment"]) : change,
    };
  }),
  // The members' rule, as for the actions: a subscription needs the read scope.
  { authorize }
);
