import * as CloudflareCluster from "@effect/platform-cloudflare/CloudflareCluster";
import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { stubs, upgrade } from "../support/socket.js";
import { foreignOrigin } from "../worker.js";

describe("ActionCluster.handler", () => {
  it.live(
    "answers a socket route's request its id refuses from the application's routes, reaching no object",
    () =>
      Effect.gen(function* () {
        const refused = yield* upgrade("Board", "foreign", {
          origin: foreignOrigin,
        });

        const admitted = yield* upgrade("Board", "admitted", {
          origin: "https://worker.example",
        });

        admitted.webSocket?.accept();
        admitted.webSocket?.close(1000);

        const { instances } = yield* stubs;

        const reached = (id: string) =>
          instances.some((instance) =>
            instance.startsWith(`${CloudflareCluster.encodeName("Board", id)}#`)
          );

        expect([refused.status, refused.webSocket]).toStrictEqual([404, null]);
        expect(admitted.status).toBe(101);
        expect([reached("foreign"), reached("admitted")]).toStrictEqual([
          false,
          true,
        ]);
      }),
    { timeout: 30_000 }
  );
});
