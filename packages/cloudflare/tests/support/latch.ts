import { Effect, Layer } from "effect";

let enter = () => {};

let release = () => {};

/** A build the test holds open: `entered` once it starts, ending as the test calls `release`. */
export const latch = {
  entered: new Promise<void>((resolve) => {
    enter = resolve;
  }),
  release: () => release(),
};

export const heldBuild = Layer.effectDiscard(
  Effect.promise(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
        enter();
      }),
  ),
);
