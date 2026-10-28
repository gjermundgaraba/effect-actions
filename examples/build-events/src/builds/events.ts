import * as Event from "@gjermundgaraba/effect-actions/Event";
import { Effect } from "effect";

import { CurrentMember } from "../identity/Identity.js";
import { BuildFinished } from "./Builds.js";
import { BuildStore } from "./store.js";

export const buildEvents = Event.implement(
  BuildFinished,
  Effect.gen(function* () {
    const store = yield* BuildStore;

    return {
      check: ({ pipeline, status }, cursor) =>
        Effect.gen(function* () {
          const member = yield* CurrentMember;

          const page = yield* store.finishedSince(
            member.pipelines,
            cursor,
            100
          );

          return {
            cursor: page.cursor,
            hasMore: page.hasMore,
            truncated: page.truncated,
            events: page.builds
              .filter(
                (build) => pipeline === undefined || build.pipeline === pipeline
              )
              .filter(
                (build) => status === undefined || build.status === status
              )
              .map((build) => ({
                eventId: `${page.epoch}/${build.id}`,
                data: build,
              })),
          };
        }),
    };
  }),
  { authorize: Event.allowAll }
);
