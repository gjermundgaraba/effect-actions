import * as Action from "@gjermundgaraba/effect-actions/Action";
import { Effect, Stream } from "effect";

import { CurrentMember } from "../identity/Identity.js";
import { TailLog } from "./Builds.js";
import { BuildStore } from "./store.js";

export const logs = Action.implement(
  TailLog,
  Effect.gen(function* () {
    const store = yield* BuildStore;

    return ({ buildId }) =>
      Stream.unwrap(
        Effect.gen(function* () {
          const member = yield* CurrentMember;
          const log = yield* store.logOf(member.pipelines, buildId);

          return Stream.fromIterable(log.map((line) => ({ line })));
        })
      );
  }),
  { authorize: Action.allowAll }
);
