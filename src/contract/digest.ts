import { Effect } from "effect";

const encoder = new TextEncoder();

/** The SHA-256 of `text`, in hex. */
export const sha256Hex = (text: string): Effect.Effect<string> =>
  Effect.promise(async () =>
    Array.from(
      new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(text))),
      (byte) => byte.toString(16).padStart(2, "0"),
    ).join(""),
  );
