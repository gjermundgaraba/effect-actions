import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, Layer, Stream } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import { RpcClient, RpcSerialization, RpcServer } from "effect/rpc";
import * as ActionHttp from "@gjermundgaraba/effect-actions/ActionHttp";
import * as ActionRpc from "@gjermundgaraba/effect-actions/ActionRpc";
import * as Testing from "@gjermundgaraba/effect-actions/Testing";
import { Http } from "../../src/Api.js";
import { ExportIssues, RateLimited } from "../../src/issues/Issues.js";
import { memory } from "../../src/memory.js";
import { publicRoutes, rpc } from "../../src/routes.js";
import { Rpc } from "../../src/Rpc.js";

// The public port's routes and the web app's rpcs under one `Testing.layer`, as server.ts
// serves them under one router.
const served = RpcClient.layerProtocolHttp({ url: "/rpc" }).pipe(
  Layer.provide(RpcSerialization.layerJson),
  Layer.provideMerge(
    Testing.layer(
      Layer.merge(
        publicRoutes,
        rpc.pipe(
          Layer.provide(RpcServer.layerProtocolHttp({ path: "/rpc" })),
          Layer.provide(RpcSerialization.layerJson),
        ),
      ),
    ),
  ),
  Layer.provide(memory),
);

const ada = {
  transformClient: HttpClient.mapRequest((request) =>
    request.pipe(
      HttpClientRequest.bearerToken("ada"),
      HttpClientRequest.setHeader("x-workspace", "acme"),
    ),
  ),
};

describe("exportIssues", () => {
  it.effect(
    "streams the issues asked for, oldest first, reporting how far it is, over HTTP and RPC",
    () =>
      Effect.gen(function* () {
        const http = yield* ActionHttp.client(Http, ada);
        const web = yield* ActionRpc.client(Rpc);

        for (const title of ["First", "Second", "Third"]) {
          yield* http.createIssue({ title, body: "" });
        }

        yield* http.closeIssue({ id: "ACME-2" });

        const reported: Array<typeof ExportIssues.progress.Type> = [];

        const overHttp = yield* Stream.runCollect(
          http.exportIssues(
            {},
            { onProgress: (progress) => Effect.sync(() => reported.push(progress)) },
          ),
        );

        // The web app's call carries its session cookie, as a browser attaches it.
        const overRpc = yield* Stream.runCollect(web.exportIssues({ status: "open" })).pipe(
          RpcClient.withHeaders({ cookie: "tracker_session=ada-at-acme" }),
        );

        const titles = (exported: ReadonlyArray<{ readonly title: string }>) =>
          exported.map(({ title }) => title);

        expect([titles(overHttp), titles(overRpc), reported]).toEqual([
          ["First", "Second", "Third"],
          ["First", "Third"],
          [
            { exported: 1, total: 3 },
            { exported: 2, total: 3 },
            { exported: 3, total: 3 },
          ],
        ]);
      }).pipe(Effect.scoped, Effect.provide(served)),
  );

  it.effect("refuses a third export in a minute before its first issue, a 429", () =>
    Effect.gen(function* () {
      const http = yield* ActionHttp.client(Http, ada);

      yield* Stream.runDrain(http.exportIssues({}));
      yield* Stream.runDrain(http.exportIssues({}));

      const refused = yield* Effect.exit(Stream.runDrain(http.exportIssues({})));

      const response = yield* HttpClient.execute(
        HttpClientRequest.post("/api/v1/exportIssues").pipe(
          HttpClientRequest.bearerToken("ada"),
          HttpClientRequest.setHeader("x-workspace", "acme"),
          HttpClientRequest.bodyJsonUnsafe({}),
        ),
      );

      expect(Exit.isFailure(refused) && Exit.findErrorOption(refused)).toMatchObject({
        value: new RateLimited({ retryAfterSeconds: 60 }),
      });
      expect(response.status).toBe(429);
    }).pipe(Effect.scoped, Effect.provide(served)),
  );
});
