import { env } from "cloudflare:test";
import { Cause, Effect, Exit, Option, Predicate, Schema } from "effect";
import { RpcClient, RpcClientError, RpcSerialization } from "effect/rpc";
import { describe, expect, it } from "@effect/vitest";
import * as ActionDurableObject from "../../src/durable/ActionDurableObject.js";
import { Expired, Instant, NativeRpcs } from "../support/native.js";

const native = RpcClient.make(NativeRpcs).pipe(
  Effect.provide(ActionDurableObject.layerStubClient(env.NATIVE.getByName("native"))),
);

const defectOf = <A, E>(exit: Exit.Exit<A, E>) =>
  Exit.isFailure(exit) && Cause.hasDies(exit.cause) ? Cause.squash(exit.cause) : undefined;

const values = {
  maybe: undefined,
  at: new Date(1_700_000_000_000),
  bytes: new Uint8Array([0, 1, 255]),
  option: Option.some(new Date(0)),
  map: new Map([["since", new Date(86_400_000)]]),
  set: new Set([1, 2, 3]),
};

describe("values over the stub", () => {
  it.effect(
    "carry a Date, bytes, undefined, an Option, a Map and a Set both ways, as they are",
    () =>
      Effect.gen(function* () {
        const client = yield* native;

        const echoed = yield* client.echo({ values });

        expect(echoed).toEqual(values);
        expect(Object.hasOwn(echoed, "maybe")).toBe(true);
        expect(echoed.at).toBeInstanceOf(Date);
        expect(echoed.bytes).toBeInstanceOf(Uint8Array);
      }).pipe(Effect.scoped),
  );

  it.effect("cross Workers RPC as values, each its schema's plain form, never JSON", () =>
    Effect.gen(function* () {
      const target = env.NATIVE.getByName("wire");
      const sent: Array<unknown> = [];
      const answered: Array<unknown> = [];

      const recording: ActionDurableObject.Stub = {
        effectActionsRpc: (request) => {
          sent.push(request);

          return target.effectActionsRpc(request).then((answer) => {
            answered.push(answer);

            return answer;
          });
        },
      };

      const client = yield* RpcClient.make(NativeRpcs).pipe(
        Effect.provide(ActionDurableObject.layerStubClient(recording)),
      );

      yield* client.echo({ values });

      const plain = {
        maybe: undefined,
        at: values.at,
        bytes: values.bytes,
        option: { _tag: "Some", value: new Date(0) },
        map: [["since", new Date(86_400_000)]],
        set: [1, 2, 3],
      };

      expect(sent).toEqual([
        [expect.objectContaining({ _tag: "Request", tag: "echo", payload: { values: plain } })],
      ]);
      expect(answered).toEqual([
        [expect.objectContaining({ _tag: "Exit", exit: { _tag: "Success", value: plain } })],
      ]);
    }).pipe(Effect.scoped),
  );

  it.effect("carry undefined at the top of a union, in and out", () =>
    Effect.gen(function* () {
      const client = yield* native;

      expect(yield* client.maybe({ value: undefined })).toBeUndefined();
      expect(yield* client.maybe({ value: "here" })).toBe("here");
    }).pipe(Effect.scoped),
  );

  it.effect("carry a declared error with a Date field", () =>
    Effect.gen(function* () {
      const client = yield* native;

      const at = new Date(1_700_000_000_000);

      expect(yield* Effect.flip(client.expire({ at }))).toEqual(new Expired({ at }));
    }).pipe(Effect.scoped),
  );

  it.effect("carry a defect, an Error, as itself", () =>
    Effect.gen(function* () {
      const client = yield* native;

      expect(defectOf(yield* Effect.exit(client.crash({ message: "boom" })))).toEqual(
        new Error("boom"),
      );
    }).pipe(Effect.scoped),
  );

  it.effect(
    "fail a call whose handler dies with its defect alone, the next call through the same client and a fresh one answered",
    () =>
      Effect.gen(function* () {
        const stub = env.NATIVE.getByName("crashed");

        const client = yield* RpcClient.make(NativeRpcs).pipe(
          Effect.provide(ActionDurableObject.layerStubClient(stub)),
        );

        const calls = (yield* ActionDurableObject.client(NativeRpcs))(() => stub);

        for (const crashing of [client, calls]) {
          const crashed = yield* Effect.exit(crashing.crash({ message: "boom" }));

          expect(defectOf(crashed)).toEqual(new Error("boom"));
          expect(yield* crashing.maybe({ value: "next" })).toBe("next");
        }

        const fresh = yield* RpcClient.make(NativeRpcs).pipe(
          Effect.provide(ActionDurableObject.layerStubClient(stub)),
        );

        expect(yield* fresh.maybe({ value: "fresh" })).toBe("fresh");
      }).pipe(Effect.scoped),
  );

  it.effect("answer a handler's die as its request's exit, never a defect of the whole call", () =>
    Effect.gen(function* () {
      const target = env.NATIVE.getByName("died");
      const sent: Array<string | number> = [];
      const answered: Array<unknown> = [];

      const recording: ActionDurableObject.Stub = {
        effectActionsRpc: (request) => {
          for (const message of request)
            if (Predicate.isTagged(message, "Request")) sent.push(message.id);

          return target.effectActionsRpc(request).then((answer) => {
            answered.push(answer);

            return answer;
          });
        },
      };

      const client = yield* RpcClient.make(NativeRpcs).pipe(
        Effect.provide(ActionDurableObject.layerStubClient(recording)),
      );

      yield* Effect.exit(client.crash({ message: "boom" }));

      expect(answered).toEqual([
        [
          {
            _tag: "Exit",
            requestId: sent[0],
            exit: { _tag: "Failure", cause: [{ _tag: "Die", defect: new Error("boom") }] },
          },
        ],
      ]);
    }).pipe(Effect.scoped),
  );

  it.effect(
    'answer each request of one call by its id as sent, 1 and "1" apart, one finishing before the other dies',
    () =>
      Effect.gen(function* () {
        const answer = yield* Effect.promise(() =>
          env.NATIVE.getByName("batched").effectActionsRpc([
            { _tag: "Request", id: 1, tag: "crashAfter", payload: { millis: 30 }, headers: [] },
            { _tag: "Request", id: "1", tag: "answerAfter", payload: { millis: 5 }, headers: [] },
          ]),
        );

        expect(answer).toEqual([
          { _tag: "Exit", requestId: "1", exit: { _tag: "Success", value: undefined } },
          {
            _tag: "Exit",
            requestId: 1,
            exit: { _tag: "Failure", cause: [{ _tag: "Die", defect: new Error("late boom") }] },
          },
        ]);
      }),
  );

  it.effect("carry a schema with no JSON form, which the socket's JSON refuses", () =>
    Effect.gen(function* () {
      const client = yield* native;

      const at = new Date(1_700_000_000_000);

      expect(yield* client.instant({ at })).toEqual(at);
      expect(() => Schema.encodeSync(RpcSerialization.json.codecFor(Instant))(at)).toThrow(
        "Expected JSON value",
      );
    }).pipe(Effect.scoped),
  );

  it.effect(
    "fail the whole call with RpcClientError on a success or defect that does not clone",
    () =>
      Effect.gen(function* () {
        const client = yield* native;

        for (const call of [client.unclonable(), client.crashUnclonable()]) {
          const error = yield* Effect.flip(call);

          expect(error).toBeInstanceOf(RpcClientError.RpcClientError);
          expect(String(error.reason.cause)).toContain("does not support serialization");
        }
      }).pipe(Effect.scoped),
  );

  it.effect("carry 31 MiB, and refuse 33 MiB with Workers RPC's limit as RpcClientError", () =>
    Effect.gen(function* () {
      const client = yield* native;

      expect((yield* client.bytes({ size: 31 * 1024 * 1024 })).byteLength).toBe(31 * 1024 * 1024);

      const error = yield* Effect.flip(client.bytes({ size: 33 * 1024 * 1024 }));

      expect(String(error.reason.cause)).toContain("limited to 32MiB");
    }).pipe(Effect.scoped),
  );
});
