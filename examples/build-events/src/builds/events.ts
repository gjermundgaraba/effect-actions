import { Effect } from "effect";
import * as Event from "@gjermundgaraba/effect-actions/Event";
import { CurrentMember } from "../identity/Identity.js";
import { BuildFinished } from "./Builds.js";
import { BuildStore } from "./store.js";

// A check source: one function answers "what finished since this cursor?" for every
// subscriber, whether it polls or holds a stream open, on every surface. The builder runs once,
// at startup; the check runs per subscriber, as that subscriber.
export const buildEvents = Event.implement(
  BuildFinished,
  Effect.gen(function* () {
    const store = yield* BuildStore;

    return {
      check: ({ pipeline, status }, cursor) =>
        Effect.gen(function* () {
          const member = yield* CurrentMember;
          // A first subscription asks with `null`: the store answers the current position, so
          // the subscriber starts from now.
          const page = yield* store.finishedSince(member.pipelines, cursor, 100);

          return {
            cursor: page.cursor,
            hasMore: page.hasMore,
            // A cursor the store cannot resume from: the subscriber is sent a gap first.
            truncated: page.truncated,
            events: page.builds
              .filter((build) => pipeline === undefined || build.pipeline === pipeline)
              .filter((build) => status === undefined || build.status === status)
              // The store's own id, within its epoch: a subscriber that sees a build twice,
              // after a reconnect, drops the second, and never drops a build of a restarted store
              // as one it saw before.
              .map((build) => ({ eventId: `${page.epoch}/${build.id}`, data: build })),
          };
        }),
    };
  }),
  // Every member may watch; which builds each sees is the store's check, by pipeline.
  { authorize: Event.allowAll },
);
