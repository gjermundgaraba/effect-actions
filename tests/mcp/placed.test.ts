import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Stream } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import * as ActionMcp from "../../src/mcp/ActionMcp.js";
import * as Testing from "../../src/testing/Testing.js";
import { authenticate } from "../support/app/authentication.js";
import { Login } from "../support/app/binding.js";
import { GetUser } from "../support/app/contracts.js";
import { Counted, target } from "../support/placed.js";

describe("ActionMcp.layerHttp serving placed contracts", () => {
  it.live(
    "answers a placed tool and a placed event's poll as the server reached answers them, with the caller's headers but MCP's routing",
    () =>
      Effect.gen(function* () {
        const reached = target();

        const answered = yield* Effect.gen(function* () {
          const mcp = yield* ActionMcp.client([GetUser, Counted], {
            transformClient: HttpClient.mapRequest((request) =>
              HttpClientRequest.setHeader(
                HttpClientRequest.bearerToken(request, "alice"),
                "x-trace",
                "t1",
              ),
            ),
          });

          return {
            user: yield* mcp.getUser({ id: "1" }),
            counts: yield* mcp
              .watch(Counted, {}, { mode: "poll" })
              .pipe(Stream.take(1), Stream.runCollect),
          };
        }).pipe(
          Effect.provide(
            Testing.layer(
              ActionMcp.layerHttp(reached.placed, {
                name: "worker",
                version: "0.0.0",
                authentication: Login,
              }).pipe(Layer.provide(authenticate)),
            ),
          ),
        );

        expect(answered.user).toEqual({ id: "1", name: "Ada" });
        expect(answered.counts.map((item) => (item._tag === "Gap" ? "gap" : item.data))).toEqual([
          { count: 0 },
        ]);
        expect(
          reached.requests.map(({ url, headers }) => [
            url,
            headers.get("authorization"),
            headers.get("x-trace"),
            [...headers.keys()].filter((name) => name.startsWith("mcp-")),
          ]),
        ).toEqual([
          ["http://localhost/api/getUser", "Bearer alice", "t1", []],
          ["http://localhost/api/events/count.changed", "Bearer alice", "t1", []],
        ]);
      }),
  );
});
