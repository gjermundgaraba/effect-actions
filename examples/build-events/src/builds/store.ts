import { Context, Effect, Layer } from "effect";

import { BuildNotFound } from "./Builds.js";
import type { Build } from "./Builds.js";

export interface Finished {
  readonly builds: readonly Build[];
  readonly cursor: string;
  readonly hasMore: boolean;
  readonly truncated: boolean;
  readonly epoch: string;
}

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

export class BuildStore extends Context.Service<
  BuildStore,
  {
    readonly finish: (
      pipeline: string,
      status: Build["status"],
      log: readonly string[]
    ) => Effect.Effect<Build>;
    readonly logOf: (
      pipelines: readonly string[],
      buildId: string
    ) => Effect.Effect<readonly string[], BuildNotFound>;
    readonly finishedSince: (
      pipelines: readonly string[],
      cursor: string | null,
      limit: number
    ) => Effect.Effect<Finished>;
    readonly statusOf: (
      pipelines: readonly string[],
      pipeline: string
    ) => Effect.Effect<Build["status"] | null>;
  }
>()("build-events/BuildStore") {
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
