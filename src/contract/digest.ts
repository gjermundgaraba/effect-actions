import { Effect } from "effect";
import { Hex } from "effect/encoding";

const encoder = new TextEncoder();

export const sha256Hex = (text: string): Effect.Effect<string> =>
  Effect.promise(async () =>
    Hex.encode(
      new Uint8Array(
        await crypto.subtle.digest("SHA-256", encoder.encode(text))
      )
    )
  );
