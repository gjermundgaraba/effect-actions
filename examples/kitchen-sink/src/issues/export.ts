import * as Action from "@gjermundgaraba/effect-actions/Action";
import { Effect, Stream } from "effect";

import { authorize } from "../identity/authorize.js";
import { ExportIssues } from "./Issues.js";
import { IssueStore } from "./store.js";
import { exportLimit } from "./write-limit.js";

export const exports = Action.implement(
  ExportIssues,
  Effect.gen(function* () {
    const store = yield* IssueStore;
    const limited = yield* exportLimit;

    return ({ status }, { progress }) =>
      Stream.unwrap(
        limited((member) =>
          Effect.map(store.count(member.workspace, status), (total) =>
            store.all(member.workspace, status).pipe(
              Stream.zipWithIndex,
              Stream.mapEffect(([issue, index]) =>
                Effect.as(progress({ exported: index + 1, total }), issue)
              )
            )
          )
        )
      );
  }),
  { authorize }
);
