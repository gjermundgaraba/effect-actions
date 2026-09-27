// What a browser page imports: the quickstart's contract and binding, and the client.
// `scripts/test-package.mjs` bundles it beside `browser-baseline.ts` and bounds the difference.
import { Effect } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import * as ActionHttp from "@gjermundgaraba/effect-actions/ActionHttp";
import { Http } from "./quickstart.js";

export const greet = (name: string) =>
  Effect.flatMap(ActionHttp.client(Http), (client) => client.greet({ name })).pipe(
    Effect.provide(FetchHttpClient.layer),
  );
