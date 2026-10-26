import { Effect, Stream } from "effect";
import * as Action from "@gjermundgaraba/effect-actions/Action";
import { authorize } from "../identity/authorize.js";
import { ExportIssues } from "./Issues.js";
import { IssueStore } from "./store.js";
import { exportLimit } from "./write-limit.js";

export const exports = Action.implement(
  ExportIssues,
  Effect.gen(function* () {
    const store = yield* IssueStore;
    const limited = yield* exportLimit;

    // The handler returns a `Stream`. The limit is spent before the first issue, so a refused
    // export fails as an action answering one value does, a 429 over HTTP; a failure after an
    // issue would end the stream instead, the issues before it already sent.
    return ({ status }, { progress }) =>
      Stream.unwrap(
        limited((member) =>
          Effect.map(store.count(member.workspace, status), (total) =>
            store.all(member.workspace, status).pipe(
              Stream.zipWithIndex,
              // `progress` never waits for the caller, dropping the oldest values a slow one has not taken:
              // `exported` may skip numbers, so it says how far the export is, not what arrived.
              Stream.mapEffect(([issue, index]) =>
                Effect.as(progress({ exported: index + 1, total }), issue),
              ),
            ),
          ),
        ),
      );
  }),
  { authorize },
);
