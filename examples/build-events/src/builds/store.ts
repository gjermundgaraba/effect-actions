import { Context, Effect, Layer } from "effect";

import { BuildNotFound } from "./Builds.js";
import type { Build } from "./Builds.js";

/** One page of the builds finished since a cursor. */
export interface Finished {
  readonly builds: readonly Build[];
  readonly cursor: string;
  readonly hasMore: boolean;
  /** Whether builds before the page may be missing: the cursor was not one of this store's. */
  readonly truncated: boolean;
  /** The store's epoch: a build's id is unique within it, and a restarted memory store starts another. */
  readonly epoch: string;
}

// The position a cursor of `epoch` names, among `length` builds; none for another epoch's cursor
// or one that is not a cursor at all.
const positionOf = (
  epoch: string,
  cursor: string,
  length: number
): number | undefined => {
  const [of, at] = cursor.split(":");
  const position = Number(at);

  return of === epoch &&
    Number.isInteger(position) &&
    position >= 0 &&
    position <= length
    ? position
    : undefined;
};

/**
 * Where finished builds are recorded, in the order they finished. Which pipelines a member may
 * see is checked here, in the data access, so no subscription can skip it.
 */
export class BuildStore extends Context.Service<
  BuildStore,
  {
    /** Record a build that finished, with the lines its log holds. */
    readonly finish: (
      pipeline: string,
      status: Build["status"],
      log: readonly string[]
    ) => Effect.Effect<Build>;
    /** The log of build `buildId`, which must be one of `pipelines`. */
    readonly logOf: (
      pipelines: readonly string[],
      buildId: string
    ) => Effect.Effect<readonly string[], BuildNotFound>;
    /**
     * The builds of `pipelines` finished after `cursor`, at most `limit`; a `null` cursor is
     * the current position, with none.
     */
    readonly finishedSince: (
      pipelines: readonly string[],
      cursor: string | null,
      limit: number
    ) => Effect.Effect<Finished>;
    /** How `pipeline`'s last build ended, `null` before any did or where it is not of `pipelines`. */
    readonly statusOf: (
      pipelines: readonly string[],
      pipeline: string
    ) => Effect.Effect<Build["status"] | null>;
  }
>()("build-events/BuildStore") {
  // DEMO ONLY: builds live in this process's memory, so a restart forgets them and numbers them
  // from 1 again. Its cursors carry an epoch of their own, so one from before the restart, or one
  // it never gave, is answered from the start as `truncated`: the subscriber is sent a gap, never
  // a silent loss. In a database the cursor is the position in its own change feed, such as a
  // sequence column, so a subscriber resumes after a restart.
  static readonly layerMemory = Layer.sync(BuildStore, () => {
    const epoch = crypto.randomUUID();
    const finished: Build[] = [];
    const logs = new Map<string, readonly string[]>();

    return BuildStore.of({
      finish: (pipeline, status, log) =>
        Effect.sync(() => {
          const build = {
            id: `build-${finished.length + 1}`,
            pipeline,
            status,
          };

          finished.push(build);
          logs.set(build.id, log);

          return build;
        }),
      logOf: (pipelines, buildId) => {
        const build = finished.find(({ id }) => id === buildId);
        const log = logs.get(buildId);

        return build === undefined ||
          log === undefined ||
          !pipelines.includes(build.pipeline)
          ? Effect.fail(new BuildNotFound({ buildId }))
          : Effect.succeed(log);
      },
      finishedSince: (pipelines, cursor, limit) =>
        Effect.sync(() => {
          const at =
            cursor === null
              ? finished.length
              : positionOf(epoch, cursor, finished.length);

          const from = at ?? 0;
          const next = finished.slice(from, from + limit);

          return {
            builds: next.filter((build) => pipelines.includes(build.pipeline)),
            cursor: `${epoch}:${from + next.length}`,
            hasMore: from + next.length < finished.length,
            truncated: at === undefined,
            epoch,
          };
        }),
      statusOf: (pipelines, pipeline) =>
        Effect.sync(() =>
          pipelines.includes(pipeline)
            ? (finished.findLast((build) => build.pipeline === pipeline)
                ?.status ?? null)
            : null
        ),
    });
  });
}
