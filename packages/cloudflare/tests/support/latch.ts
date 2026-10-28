import { Effect, Layer } from "effect";

const entered = Promise.withResolvers<undefined>();

let held: PromiseWithResolvers<undefined> | undefined;

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
