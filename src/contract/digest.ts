import { Effect, Schema } from "effect";

const encoder = new TextEncoder();

const encodeHex = Schema.encodeSync(Schema.Uint8ArrayFromHex);

export const sha256Hex = (text: string): Effect.Effect<string> =>
  Effect.promise(async () =>
    encodeHex(
      new Uint8Array(
        await crypto.subtle.digest("SHA-256", encoder.encode(text))
      )
    )
  );
