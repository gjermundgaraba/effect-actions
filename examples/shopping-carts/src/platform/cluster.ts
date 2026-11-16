import { Layer } from "effect";
import { SingleRunner } from "effect/cluster";
import { Digest } from "effect/crypto";

export const layerSingleRunner = SingleRunner.layer({
  runnerStorage: "memory",
}).pipe(Layer.orDie, Layer.provide(Digest.layerWebCrypto));
