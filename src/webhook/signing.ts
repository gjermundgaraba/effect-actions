import { Effect } from "effect";
import { Base64, Hex } from "effect/encoding";

import { sha256Hex } from "../contract/digest.js";

const encoder = new TextEncoder();

const hmac = (key: Uint8Array, content: string) =>
  Effect.promise(async () => {
    const imported = await crypto.subtle.importKey(
      "raw",
      Uint8Array.from(key),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );

    return new Uint8Array(
      await crypto.subtle.sign("HMAC", imported, encoder.encode(content))
    );
  });

/**
 * A delivery's `webhook-signature`: Standard Webhooks' `v1,` HMAC-SHA256 of `id.timestamp.body`
 * under each key, space apart, so a receiver mid-rotation verifies under either.
 */
export const signature = (
  keys: readonly Uint8Array[],
  id: string,
  timestamp: number,
  body: string
): Effect.Effect<string> =>
  Effect.map(
    Effect.forEach(keys, (key) => hmac(key, `${id}.${timestamp}.${body}`)),
    (signed) => signed.map((bytes) => `v1,${Base64.encode(bytes)}`).join(" ")
  );

export const subscriptionId = (key: string): Effect.Effect<string> =>
  Effect.map(sha256Hex(key), (hex) => `sub_${hex.slice(0, 32)}`);

export const randomToken: Effect.Effect<string> = Effect.sync(() =>
  Hex.encode(crypto.getRandomValues(new Uint8Array(16)))
);

export const constantTimeEqual = (a: string, b: string): boolean => {
  const left = encoder.encode(a);
  const right = encoder.encode(b);

  return (
    left.length === right.length &&
    left.reduce(
      (differs, byte, index) => differs | (byte ^ (right[index] ?? 0)),
      0
    ) === 0
  );
};
