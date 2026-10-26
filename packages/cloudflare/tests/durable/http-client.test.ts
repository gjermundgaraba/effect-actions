import { env } from "cloudflare:test";
import { Effect, Layer } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import { RpcClient, RpcSerialization } from "effect/rpc";
import { describe, expect, it } from "@effect/vitest";
import * as ActionHttp from "@gjermundgaraba/effect-actions/ActionHttp";
import * as ActionRpc from "@gjermundgaraba/effect-actions/ActionRpc";
import * as ActionDurableObject from "../../src/durable/ActionDurableObject.js";
import { Http, Overdrawn, Rpc } from "../support/app.js";

const signedIn = (token: string) => HttpClient.mapRequest(HttpClientRequest.bearerToken(token));

describe("layerHttpClient", () => {
  it.effect("calls an object's JSON routes, decoding its success and declared errors", () =>
    Effect.gen(function* () {
      const client = yield* ActionHttp.client(Http, {
        baseUrl: "https://object",
        transformClient: signedIn("ada"),
      });

      expect(yield* client.whoami()).toBe("ada");
      expect(yield* client.spend({ amount: 4 })).toEqual({ left: 6 });
      expect(yield* Effect.flip(client.spend({ amount: 7 }))).toEqual(new Overdrawn({ by: 1 }));
    }).pipe(Effect.provide(ActionDurableObject.layerHttpClient(env.PLAIN.getByName("http")))),
  );

  it.effect("calls an object's rpcs over Effect's HTTP protocol", () =>
    Effect.gen(function* () {
      const client = yield* ActionRpc.client(Rpc);
      const asGrace = RpcClient.withHeaders({ authorization: "Bearer grace" });

      expect(yield* client.whoami().pipe(asGrace)).toBe("grace");
      expect(yield* client.spend({ amount: 10 }).pipe(asGrace)).toEqual({ left: 0 });
    }).pipe(
      Effect.scoped,
      Effect.provide(
        RpcClient.layerProtocolHttp({ url: "https://object/rpc" }).pipe(
          Layer.provide([
            ActionDurableObject.layerHttpClient(env.PLAIN.getByName("rpc")),
            RpcSerialization.layerJson,
          ]),
        ),
      ),
    ),
  );
});
