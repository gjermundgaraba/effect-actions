import { Clock, Effect, Option, Predicate, Schema } from "effect";
import type { Scope } from "effect";
import { Base64, Base64Url } from "effect/encoding";
import { HttpServerRequest, HttpServerResponse } from "effect/http";

import { watchParameter } from "../contract/receiving.js";
import type {
  Delivered,
  Receiving,
  Registered,
} from "../contract/receiving.js";
import { makeRecent } from "../contract/recent.js";
import type { Recent } from "../contract/recent.js";
import { constantTimeEqual, signature } from "./signing.js";

const timestampToleranceSeconds = 5 * 60;

const dedupeWindow = 1000;

const Body = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Json));

const decodeBody = Schema.decodeUnknownOption(Body);

interface Place {
  readonly key: Uint8Array;
  readonly deliver: (body: Delivered) => boolean;
  readonly seen: Recent;
}

const gone = HttpServerResponse.empty({ status: 410 });

const unauthorized = HttpServerResponse.empty({ status: 401 });

export const makeReceiver = (path: `/${string}`) =>
  Effect.sync(() => {
    const places = new Map<string, Place>();

    const register = (
      deliver: (body: Delivered) => boolean
    ): Effect.Effect<Registered, never, Scope.Scope> =>
      Effect.acquireRelease(
        Effect.sync(() => {
          const id = Base64Url.encode(
            crypto.getRandomValues(new Uint8Array(16))
          );

          const key = crypto.getRandomValues(new Uint8Array(32));

          places.set(id, { key, deliver, seen: makeRecent(dedupeWindow) });

          return { id, secret: { text: `whsec_${Base64.encode(key)}`, key } };
        }),
        ({ id }) => Effect.sync(() => places.delete(id))
      );

    const handler = Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;

      const named = (yield* HttpServerRequest.ParsedSearchParams)[
        watchParameter
      ];

      const place = Predicate.isString(named) ? places.get(named) : undefined;

      if (place === undefined) {
        return gone;
      }

      const id = request.headers["webhook-id"];
      const timestamp = Number(request.headers["webhook-timestamp"]);

      const signatures = (request.headers["webhook-signature"] ?? "").split(
        " "
      );

      const now = Math.floor((yield* Clock.currentTimeMillis) / 1000);

      if (
        id === undefined ||
        !Number.isInteger(timestamp) ||
        Math.abs(now - timestamp) > timestampToleranceSeconds
      ) {
        return unauthorized;
      }

      const text = yield* Effect.orElseSucceed(request.text, () => "");
      const expected = yield* signature([place.key], id, timestamp, text);

      if (!signatures.some((each) => constantTimeEqual(each, expected))) {
        return unauthorized;
      }

      const body = decodeBody(text);

      if (Option.isNone(body)) {
        return HttpServerResponse.empty({ status: 400 });
      }

      if (body.value["type"] === "verification") {
        return HttpServerResponse.jsonUnsafe({
          challenge: body.value["challenge"],
        });
      }

      if (place.seen.has(id)) {
        return HttpServerResponse.empty();
      }

      if (!place.deliver(body.value)) {
        return HttpServerResponse.empty({ status: 503 });
      }

      place.seen.add(id);

      return HttpServerResponse.empty();
    });

    return {
      receiving: { path, register } satisfies Receiving["Service"],
      handler,
    };
  });
