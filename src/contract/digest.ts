import { Effect } from "effect";

const encoder = new TextEncoder();

// Why: A browser client imports this, through `Action`'s idempotency keys, though it never runs a
// digest; a page's import map serves Effect's browser barrels alone, which `effect/encoding`'s
// `Hex` is not one of, so tests/browser.test.ts fails where this imports it.
/** The SHA-256 of `text`, in hex. */
export const sha256Hex = (text: string): Effect.Effect<string> =>
  Effect.promise(async () =>
    Array.from(
      new Uint8Array(
        await crypto.subtle.digest("SHA-256", encoder.encode(text))
      ),
      (byte) => byte.toString(16).padStart(2, "0")
    ).join("")
  );
