import { describe, expect, it } from "@effect/vitest";
import { Cause, Deferred, Effect, ErrorReporter, Exit, Layer, Schema, Stream } from "effect";
import { RpcClient } from "effect/rpc";
import * as Action from "../../src/contract/Action.js";
import * as Authentication from "../../src/authentication/Authentication.js";
import * as ActionRpc from "../../src/rpc/ActionRpc.js";
import { verify } from "../support/app/authentication.js";
import { CurrentActor } from "../support/app/authorization.js";
import { Count, countsReleasing } from "../support/app/count.js";
import { recorder } from "../support/reporter.js";
import { overHttp } from "../support/rpc.js";

class LogGone extends Schema.TaggedError<LogGone>()("LogGone", { at: Schema.Finite }) {}

const Tail = Action.make("tail", {
  description: "Follow a log, line by line.",
  input: {
    count: Schema.Finite,
    halt: Schema.optional(Schema.Literals(["defect", "unencodable"])),
  },
  success: Action.Stream({ n: Schema.Finite }),
  error: LogGone,
  readOnly: true,
  caller: Action.Anyone,
});

const Build = Action.make("build", {
  description: "Stream a build's lines as the caller, reporting its step.",
  input: { steps: Schema.Finite },
  success: Action.Stream({ line: Schema.String }),
  progress: { step: Schema.Finite },
  readOnly: false,
  caller: CurrentActor,
});

const Login = Authentication.make("rpc-stream.Login", CurrentActor);

const lines = (count: number) => Stream.map(Stream.range(1, count), (n) => ({ n }));

const tails = Action.implement(Tail, ({ count, halt }) => {
  if (halt === "defect")
    return Stream.concat(lines(count), Stream.die(new Error("the log's secret detail")));

  if (halt === "unencodable") return Stream.concat(lines(count), Stream.make({ n: Number.NaN }));

  return lines(count);
});

const builds = Action.implement(
  Build,
  ({ steps }, { progress }) =>
    Stream.mapEffect(Stream.range(1, steps), (step) =>
      Effect.flatMap(CurrentActor, ({ id }) =>
        Effect.as(progress({ step }), { line: `${id}: step ${step}` }),
      ),
    ),
  { authorize: () => Effect.void },
);

const Rpc = ActionRpc.make([Tail, Build], { authentication: Login });

const served = (reported: Array<string> = []) =>
  overHttp(
    ActionRpc.layer(Rpc, [tails, builds]).pipe(
      Layer.provide(Authentication.layer(Login, verify)),
      Layer.provide(ErrorReporter.layer([recorder(reported)])),
    ),
  );

const Counting = ActionRpc.make([Count]);

const signedInAs = (token: string) => RpcClient.withHeaders({ authorization: `Bearer ${token}` });

describe("RPC element streams", () => {
  it.effect("streams the elements, none for an empty stream", () =>
    Effect.gen(function* () {
      const client = yield* ActionRpc.client(Rpc);

      expect(yield* Stream.runCollect(client.tail({ count: 3 }))).toEqual([
        { n: 1 },
        { n: 2 },
        { n: 3 },
      ]);
      expect(yield* Stream.runCollect(client.tail({ count: 0 }))).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(served())),
  );

  it.effect("streams each element as an Element to a native client, beside its progress", () =>
    Effect.gen(function* () {
      const client = yield* RpcClient.make(Rpc.group);

      const tailed = yield* Stream.runCollect(client.tail({ count: 1 }));
      const built = yield* Stream.runCollect(client.build({ steps: 1 })).pipe(signedInAs("alice"));

      expect(tailed).toEqual([{ _tag: "Element", value: { n: 1 } }]);
      expect(built.toSorted((left, right) => left._tag.localeCompare(right._tag))).toEqual([
        { _tag: "Element", value: { line: "alice: step 1" } },
        { _tag: "Progress", value: { step: 1 } },
      ]);
    }).pipe(Effect.scoped, Effect.provide(served())),
  );

  it.effect(
    "ends a stream whose handler dies, or whose element does not encode, as Internal server error, reported",
    () => {
      const reported: Array<string> = [];

      return Effect.gen(function* () {
        const client = yield* ActionRpc.client(Rpc);

        const died = yield* Effect.exit(Stream.runDrain(client.tail({ count: 1, halt: "defect" })));

        const unencodable = yield* Effect.exit(
          Stream.runDrain(client.tail({ count: 1, halt: "unencodable" })),
        );

        for (const exit of [died, unencodable]) {
          expect(Exit.isFailure(exit) && Cause.pretty(exit.cause)).toContain(
            "Internal server error",
          );
        }

        expect(Exit.isFailure(died) && Cause.pretty(died.cause)).not.toContain("secret detail");
        expect(reported).toEqual([
          expect.stringContaining("the log's secret detail"),
          expect.stringContaining("Expected a finite number"),
        ]);
      }).pipe(Effect.scoped, Effect.provide(served(reported)));
    },
  );

  it.effect("streams a protected action as the call's caller, handing progress to onProgress", () =>
    Effect.gen(function* () {
      const client = yield* ActionRpc.client(Rpc);
      const reported: Array<number> = [];

      const built = yield* Stream.runCollect(
        client.build(
          { steps: 2 },
          { onProgress: ({ step }) => Effect.sync(() => reported.push(step)) },
        ),
      ).pipe(signedInAs("alice"));

      const refused = yield* Effect.exit(Stream.runDrain(client.build({ steps: 1 })));

      expect([built, reported]).toEqual([
        [{ line: "alice: step 1" }, { line: "alice: step 2" }],
        [1, 2],
      ]);
      expect(Exit.isFailure(refused) && Cause.squash(refused.cause)).toBeInstanceOf(
        Action.Unauthenticated,
      );
    }).pipe(Effect.scoped, Effect.provide(served())),
  );

  it.effect("closes the handler's stream once the caller stops reading", () =>
    Effect.gen(function* () {
      const released = yield* Deferred.make<void>();

      const counted = yield* Effect.gen(function* () {
        const client = yield* ActionRpc.client(Counting);

        return yield* Stream.runCollect(Stream.take(client.count(), 3));
      }).pipe(
        Effect.scoped,
        Effect.provide(overHttp(ActionRpc.layer(Counting, countsReleasing(released)))),
      );

      yield* Deferred.await(released);

      expect(counted).toEqual([0, 1, 2]);
    }),
  );
});
