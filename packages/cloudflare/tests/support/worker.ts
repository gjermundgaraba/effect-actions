import * as ActionHttp from "@gjermundgaraba/effect-actions/ActionHttp";
import { exports } from "cloudflare:workers";
import { Effect, Layer, Schema } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";

import { SeerHttp } from "../worker.js";
import { eventually } from "./eventually.js";

export const throughWorker = FetchHttpClient.layer.pipe(
  Layer.provide(
    Layer.succeed(FetchHttpClient.Fetch)(
      async (input, init) =>
        await exports.default.fetch(new Request(input, init))
    )
  )
);

export const asAlice = ActionHttp.client(SeerHttp, {
  baseUrl: "https://worker.example",
  transformClient: HttpClient.mapRequest(
    HttpClientRequest.bearerToken("alice")
  ),
});

const drained = (path: string) =>
  Effect.promise(async (): Promise<unknown> => {
    const response = await exports.default.fetch(
      `https://worker.example${path}`
    );

    return await response.json();
  });

const Received = Schema.Array(
  Schema.Struct({
    tag: Schema.String,
    authorization: Schema.NullOr(Schema.String),
  })
);

export const received = drained("/received").pipe(
  Effect.flatMap(Schema.decodeUnknownEffect(Received)),
  Effect.orDie
);

export const logged = drained("/logged").pipe(
  Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Schema.String))),
  Effect.orDie
);

export const gathered = <A>(
  drain: Effect.Effect<readonly A[]>,
  done: (all: readonly A[]) => boolean
) =>
  Effect.suspend(() => {
    const all: A[] = [];

    return drain.pipe(
      Effect.map((more) => {
        all.push(...more);

        return all;
      }),
      eventually(done)
    );
  });
