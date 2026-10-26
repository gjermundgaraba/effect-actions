import { Effect } from "effect";

const encoder = new TextEncoder();

// Why: An idempotency key's record id is digested in a browser client too, through `Action`, and
// a browser's import map serves Effect's browser barrels alone, which `effect/encoding`'s `Hex` is
// not one of; tests/browser.test.ts fails where this imports it.
/** The SHA-256 of `text`, in hex. */
export const sha256Hex = (text: string): Effect.Effect<string> =>
  Effect.promise(async () =>
    Array.from(
      new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(text))),
      (byte) => byte.toString(16).padStart(2, "0"),
    ).join(""),
  );
