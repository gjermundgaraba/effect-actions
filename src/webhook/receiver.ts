import { Clock, Effect, Option, Predicate, Schema, type Scope } from "effect";
import { Base64, Base64Url } from "effect/encoding";
import { HttpServerRequest, HttpServerResponse } from "effect/http";
import {
  type Delivered,
  type Receiving,
  type Registered,
  watchParameter,
} from "../contract/receiving.js";
import { makeRecent, type Recent } from "../contract/recent.js";
import { constantTimeEqual, signature } from "./signing.js";

/** How old a delivery's `webhook-timestamp` may be, or how far ahead, before it is refused. */
const tolerance = 5 * 60;

const dedupeWindow = 1000;

const Body = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Json));

const decodeBody = Schema.decodeUnknownOption(Body);

interface Place {
  readonly key: Uint8Array;
  readonly deliver: (body: Delivered) => boolean;
  readonly seen: Recent;
}

// Why: A POST naming no watch here is for one that ended, or one of a process that restarted,
// whose secret is gone: a 410 is the one failure the server does not retry, and SEP-3415 has it
// abandon that delivery alone, so such a subscription lapses at its grant.
const gone = HttpServerResponse.empty({ status: 410 });

const unauthorized = HttpServerResponse.empty({ status: 401 });

/**
 * The receiver of one `Webhook.layerReceiver` at `path`: `receiving`, where each watch keeps its
 * place under an id and a secret of its own, and `handler`, which verifies a POST against the
 * secret of the watch its URL names and hands its body to that watch.
 */
export const makeReceiver = (path: `/${string}`) =>
  Effect.sync(() => {
    const places = new Map<string, Place>();

    const register = (
      deliver: (body: Delivered) => boolean,
    ): Effect.Effect<Registered, never, Scope.Scope> =>
      Effect.acquireRelease(
        Effect.sync(() => {
          const id = Base64Url.encode(crypto.getRandomValues(new Uint8Array(16)));
          const key = crypto.getRandomValues(new Uint8Array(32));

          places.set(id, { key, deliver, seen: makeRecent(dedupeWindow) });

          return { id, secret: { text: `whsec_${Base64.encode(key)}`, key } };
        }),
        ({ id }) => Effect.sync(() => places.delete(id)),
      );

    const handler = Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const named = (yield* HttpServerRequest.ParsedSearchParams)[watchParameter];
      const place = Predicate.isString(named) ? places.get(named) : undefined;

      if (place === undefined) return gone;

      const id = request.headers["webhook-id"];
      const timestamp = Number(request.headers["webhook-timestamp"]);
      const signatures = (request.headers["webhook-signature"] ?? "").split(" ");
      const now = Math.floor((yield* Clock.currentTimeMillis) / 1000);

      if (id === undefined || !Number.isInteger(timestamp) || Math.abs(now - timestamp) > tolerance)
        return unauthorized;

      const text = yield* Effect.orElseSucceed(request.text, () => "");
      const expected = yield* signature([place.key], id, timestamp, text);

      if (!signatures.some((each) => constantTimeEqual(each, expected))) return unauthorized;

      const body = decodeBody(text);

      if (Option.isNone(body)) return HttpServerResponse.empty({ status: 400 });

      if (body.value["type"] === "verification")
        return HttpServerResponse.jsonUnsafe({ challenge: body.value["challenge"] });

      if (place.seen.has(id)) return HttpServerResponse.empty();

      if (!place.deliver(body.value)) return HttpServerResponse.empty({ status: 503 });

      place.seen.add(id);

      return HttpServerResponse.empty();
    });

    return { receiving: { path, register } satisfies Receiving["Service"], handler };
  });
