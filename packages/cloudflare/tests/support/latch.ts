import { Effect, Layer } from "effect";

const entered = Promise.withResolvers<undefined>();

let held: PromiseWithResolvers<undefined> | undefined;

/** A build the test holds open: `entered` once it starts, ending as the test calls `release`. */
export const latch = {
  entered: entered.promise,
  release: () => {
    held?.resolve(undefined);
  },
};

export const heldBuild = Layer.effectDiscard(
  Effect.promise(async () => {
    held = Promise.withResolvers<undefined>();
    entered.resolve(undefined);
    await held.promise;
  })
);
