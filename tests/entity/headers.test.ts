import { describe, expect, it } from "@effect/vitest";
import { Arbitrary, Effect, Layer, Schema } from "effect";
import { TestRunner } from "effect/cluster";
import { Headers, HttpServerRequest } from "effect/http";
import { RpcClient } from "effect/rpc";

import * as Action from "../../src/contract/Action.js";
import * as ActionEntity from "../../src/entity/ActionEntity.js";
import * as ActionRpc from "../../src/rpc/ActionRpc.js";
import {
  actors,
  authorize,
  CurrentActor,
} from "../support/app/authorization.js";
import { Login } from "../support/app/binding.js";
import { signIn } from "../support/rooms.js";

const Read = { headers: Schema.Record(Schema.String, Schema.String) };

const ReadHeaders = Action.make("readHeaders", {
  description: "Answer the headers the entity authenticated the call from.",
  input: { room: Schema.String },
  success: { ...Read, by: Schema.String },
  readOnly: true,
  caller: CurrentActor,
});

const StreamHeaders = Action.make("streamHeaders", {
  description: "Answer them after a progress step, as a stream rpc.",
  input: { room: Schema.String },
  success: { ...Read, by: Schema.String },
  progress: { step: Schema.Int },
  readOnly: true,
  caller: CurrentActor,
});

const Reader = ActionEntity.make(
  "Reader",
  ActionRpc.make([ReadHeaders, StreamHeaders], { authentication: Login }),
  {
    key: {
      readHeaders: ({ room }) => room,
      streamHeaders: ({ room }) => room,
    },
  }
);

const seen = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const actor = yield* CurrentActor;

  return { headers: { ...request.headers }, by: actor.id };
});

const reading = [
  Action.implement(ReadHeaders, () => seen, { authorize }),
  Action.implement(
    StreamHeaders,
    (_, { progress }) => Effect.andThen(progress({ step: 1 }), seen),
    { authorize }
  ),
];

const readers = ActionEntity.layer(Reader, reading).pipe(
  Layer.provideMerge(TestRunner.layer),
  Layer.provide(signIn)
);

const Extra = Schema.Record(
  Schema.Union([
    Schema.Literals([
      "cookie",
      "user-agent",
      "referer",
      "origin",
      "forwarded",
      "via",
      "cache-control",
      "pragma",
      "if-none-match",
      "if-modified-since",
      "x-forwarded-for",
      "x-real-ip",
    ]),
    Schema.String.check(Schema.isPattern(/^x-[a-z]{1,8}$/u)),
  ]),
  Schema.String.check(Schema.isPattern(/^[a-z0-9]{0,12}$/u))
);

describe("ActionEntity.layer's headers on a TestRunner", () => {
  it.live.prop(
    "authenticates a unary and a stream rpc from exactly the headers their client sent",
    [Arbitrary.schema(Extra)],
    ([extra]) =>
      Effect.gen(function* () {
        const sent = { ...extra, authorization: "Bearer alice" };
        const reader = yield* ActionEntity.client(Reader);

        const unary = yield* reader
          .readHeaders({ room: "a" })
          .pipe(RpcClient.withHeaders(sent));

        const steps: number[] = [];

        const streamed = yield* reader
          .streamHeaders(
            { room: "a" },
            { onProgress: ({ step }) => Effect.sync(() => steps.push(step)) }
          )
          .pipe(RpcClient.withHeaders(sent));

        expect(unary).toStrictEqual({ headers: sent, by: "alice" });
        expect(streamed).toStrictEqual({ headers: sent, by: "alice" });
        expect(steps).toStrictEqual([1]);
      }).pipe(Effect.scoped, Effect.provide(readers)),
    { timeout: 30_000, arbitrary: { runs: 50 } }
  );
});

const ownedByTheRequest = {
  host: "localhost",
  connection: "keep-alive",
  "keep-alive": "timeout=5",
  te: "trailers",
  trailer: "expires",
  "transfer-encoding": "chunked",
  upgrade: "websocket",
  "content-type": "application/json",
  "content-length": "12",
  accept: "text/event-stream",
  "accept-encoding": "gzip",
  "proxy-authorization": "Basic cHJveHk6cHJveHk=",
  "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
  "mcp-session-id": "session",
  "mcp-protocol-version": "2026-07-28",
};

describe("ActionEntity.reaching's forwarded headers", () => {
  it.live.prop(
    "sends every header of the caller's request on but its connection's, its body's, what it accepts and MCP's routing",
    [Arbitrary.schema(Extra)],
    ([extra]) => {
      const kept = { ...extra, authorization: "Bearer alice" };

      const request = HttpServerRequest.fromWeb(
        new Request("http://localhost/readHeaders")
      ).modify({
        headers: Headers.fromInput({ ...ownedByTheRequest, ...kept }),
      });

      return Effect.gen(function* () {
        const client = yield* Action.client(ActionEntity.reaching(Reader));

        expect(yield* client.readHeaders({ room: "a" })).toStrictEqual({
          headers: kept,
          by: "alice",
        });
      }).pipe(
        Effect.provideService(HttpServerRequest.HttpServerRequest, request),
        Effect.provideService(CurrentActor, actors.alice),
        Effect.scoped,
        Effect.provide(readers)
      );
    },
    { timeout: 30_000, arbitrary: { runs: 20 } }
  );
});
