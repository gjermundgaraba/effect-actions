import * as CloudflareCluster from "@effect/platform-cloudflare/CloudflareCluster";
import { describe, expect, it } from "@effect/vitest";
import { exports } from "cloudflare:workers";
import { Effect } from "effect";

import { stubs, upgrade } from "../support/socket.js";
import { foreignOrigin } from "../worker.js";

const reached = (id: string) =>
  Effect.map(stubs, ({ instances }) =>
    instances.some((instance) =>
      instance.startsWith(`${CloudflareCluster.encodeName("Board", id)}#`)
    )
  );

const fetched = (path: string, init: RequestInit = {}) =>
  Effect.promise(async () => {
    const response = await exports.default.fetch(
      `https://worker.example${path}`,
      init
    );

    return {
      status: response.status,
      fallback: response.headers.get("x-fallback"),
      cookies: response.headers.getSetCookie(),
      body: await response.text(),
    };
  });

describe("ActionWorker.make's fetch", () => {
  it.live(
    "refuses a foreign Origin 403 before any socket, and answers an upgrade its socket's id refuses 404, reaching neither object",
    () =>
      Effect.gen(function* () {
        const foreign = yield* upgrade("Board", "foreign", {
          origin: foreignOrigin,
        });

        const refused = yield* upgrade("Board", "refused");

        const admitted = yield* upgrade("Board", "admitted", {
          origin: "https://worker.example",
        });

        admitted.webSocket?.accept();
        admitted.webSocket?.close(1000);

        expect([foreign.status, foreign.webSocket]).toStrictEqual([403, null]);
        expect([refused.status, refused.webSocket]).toStrictEqual([404, null]);
        expect(admitted.status).toBe(101);
        expect([
          yield* reached("foreign"),
          yield* reached("refused"),
          yield* reached("admitted"),
        ]).toStrictEqual([false, false, true]);
      }),
    { timeout: 30_000 }
  );

  it.live(
    "hands an upgrade to the object of the socket's id percent-decoded, the id ActionEntity.reaching keys a call to",
    () =>
      Effect.gen(function* () {
        const admitted = yield* upgrade("Board", encodeURIComponent("café"));

        admitted.webSocket?.accept();
        admitted.webSocket?.close(1000);

        expect(admitted.status).toBe(101);
        expect([
          yield* reached("café"),
          yield* reached("caf%C3%A9"),
        ]).toStrictEqual([true, false]);
      }),
    { timeout: 30_000 }
  );

  it.live(
    "answers a request no route matches with fallback, but not a route's own 404 or route miss, an upgrade no socket matches, or a refused one",
    () =>
      Effect.gen(function* () {
        const page = yield* fetched("/rooms/lobby");
        const socketPath = yield* fetched("/sockets/Board/plain");
        const routed = yield* fetched("/gone");

        const stray = yield* fetched("/nowhere", {
          headers: { upgrade: "websocket" },
        });

        const foreign = yield* fetched("/rooms/lobby", {
          headers: { origin: foreignOrigin },
        });

        expect(page).toStrictEqual({
          status: 200,
          fallback: "page",
          cookies: ["seen=1; Path=/a", "seen=2; Path=/b"],
          body: "page /rooms/lobby",
        });
        expect(socketPath.fallback).toBe("page");
        expect([routed.status, routed.fallback, routed.body]).toStrictEqual([
          404,
          null,
          "gone",
        ]);
        expect([stray.status, stray.fallback]).toStrictEqual([404, null]);
        expect([foreign.status, foreign.body]).toStrictEqual([
          403,
          "Forbidden",
        ]);
      }),
    { timeout: 30_000 }
  );
});
