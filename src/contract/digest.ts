import { Effect } from "effect";
import { Hex } from "effect/encoding";

const encoder = new TextEncoder();

/** The SHA-256 of `text`, in hex. */
export const sha256Hex = (text: string): Effect.Effect<string> =>
  Effect.promise(async () =>
    Hex.encode(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(text)))),
  );
