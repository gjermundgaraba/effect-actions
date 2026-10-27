import * as Action from "@gjermundgaraba/effect-actions/Action";
import { Effect, Stream } from "effect";

import { CurrentMember } from "../identity/Identity.js";
import { TailLog } from "./Builds.js";
import { BuildStore } from "./store.js";

export const logs = Action.implement(
  TailLog,
  Effect.gen(function* () {
    const store = yield* BuildStore;

    // The handler returns a `Stream`, run in a scope of its own that closes when the caller
    // stops reading, so what it acquires is released then.
    return ({ buildId }) =>
      Stream.unwrap(
        Effect.gen(function* () {
          const member = yield* CurrentMember;
          // A failure before the first line, `BuildNotFound` here, fails the call as an action
          // answering one value fails, a 404 over HTTP; one after a line ends the stream, the
          // lines before it already read.
          const log = yield* store.logOf(member.pipelines, buildId);

          return Stream.fromIterable(log.map((line) => ({ line })));
        })
      );
  }),
  // Which builds a member may read is the store's check, by pipeline.
  { authorize: Action.allowAll }
);
