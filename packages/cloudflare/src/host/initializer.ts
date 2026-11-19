import { Layer, ManagedRuntime } from "effect";
import type { Context } from "effect";
import { HttpRouter } from "effect/http";

/**
 * The function `CloudflareDurableObjects.setInitializer` takes: it builds `application(env)`, with
 * `HttpRouter.layer` beneath it, in a `ManagedRuntime` of its own on each call, and keeps the
 * first runtime to finish for the isolate, disposing a failed one and leaving a later one alive
 * for the isolate's life, since it may hold the isolate's entity registrations. A call whose build
 * fails answers the kept runtime, or rejects with its failure when none was kept, so the next call
 * builds again.
 */
export const initializer = <Env, A, E>(
  application: (env: Env) => Layer.Layer<A, E, HttpRouter.HttpRouter>
): ((env: Env) => Promise<Context.Context<A | HttpRouter.HttpRouter>>) => {
  let kept:
    | ManagedRuntime.ManagedRuntime<A | HttpRouter.HttpRouter, E>
    | undefined;

  const build = async (env: Env) => {
    const runtime = ManagedRuntime.make(
      application(env).pipe(Layer.provideMerge(HttpRouter.layer))
    );

    try {
      await runtime.context();
    } catch (error) {
      await runtime.dispose();

      if (kept === undefined) {
        throw error;
      }

      return kept;
    }

    kept ??= runtime;

    return kept;
  };

  return async (env) => await (kept ?? (await build(env))).context();
};
