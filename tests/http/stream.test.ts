import { assert, describe, expect, it } from "@effect/vitest";
import { Cause, Deferred, Effect, Exit, Schema, Stream } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import { OpenApi } from "effect/http-api";

import * as Action from "../../src/contract/Action.js";
import * as ActionHttp from "../../src/http/ActionHttp.js";
import * as Testing from "../../src/testing/Testing.js";
import { Count, countsReleasing } from "../support/app/count.js";
import { call, framesOf } from "../support/sse.js";

class LogGone extends Schema.TaggedError<
  LogGone,
  { readonly brand: unique symbol }
>()("LogGone", { at: Schema.Finite }, { httpApiStatus: 410 }) {}

const Tail = Action.make("tail", {
  description: "Follow a log, line by line.",
  input: {
    count: Schema.Finite,
    halt: Schema.optional(Schema.Literals(["before", "after", "defect"])),
  },
  success: Action.Stream({ n: Schema.Finite }),
  error: LogGone,
  readOnly: true,
  caller: Action.Anyone,
});

const Build = Action.make("build", {
  description: "Stream a build's lines, reporting its step.",
  input: { steps: Schema.Finite },
  success: Action.Stream({ line: Schema.String }),
  progress: { step: Schema.Finite },
  readOnly: false,
  caller: Action.Anyone,
});

const lines = (count: number) =>
  Stream.map(Stream.range(1, count), (n) => ({ n }));

const tails = Action.implement(Tail, ({ count, halt }) => {
  if (halt === "before") {
    return Stream.fail(new LogGone({ at: 0 }));
  }

  if (halt === "after") {
    return Stream.concat(lines(count), Stream.fail(new LogGone({ at: count })));
  }

  if (halt === "defect") {
    return Stream.concat(
      lines(count),
      Stream.die(new Error("the log's secret detail"))
    );
  }

  return lines(count);
});

const builds = Action.implement(Build, ({ steps }, { progress }) =>
  Stream.mapEffect(Stream.range(1, steps), (step) =>
    Effect.as(progress({ step }), { line: `step ${step}` })
  )
);

const Http = ActionHttp.make([Tail, Build]);

const Counting = ActionHttp.make([Count]);

const served = () => Testing.layer(ActionHttp.layer(Http, [tails, builds]));

describe("HTTP element streams", () => {
  it.effect("streams each element as an element event", () =>
    Effect.gen(function* () {
      const response = yield* call("tail", { count: 2 });

      expect([response.status, response.headers["content-type"]]).toStrictEqual(
        [200, "text/event-stream"]
      );
      expect(yield* framesOf(response)).toStrictEqual([
        { event: "element", data: { n: 1 } },
        { event: "element", data: { n: 2 } },
      ]);
    }).pipe(Effect.provide(served()))
  );

  it.effect(
    "streams without asking for an event stream, there being no other answer",
    () =>
      Effect.gen(function* () {
        const response = yield* HttpClient.execute(
          HttpClientRequest.post("/api/tail").pipe(
            HttpClientRequest.bodyJsonUnsafe({ count: 1 })
          )
        );

        expect(yield* framesOf(response)).toStrictEqual([
          { event: "element", data: { n: 1 } },
        ]);
      }).pipe(Effect.provide(served()))
  );

  it.effect("answers a stream of no element with a 200 and no event", () =>
    Effect.gen(function* () {
      const response = yield* call("tail", { count: 0 });

      expect([response.status, yield* framesOf(response)]).toStrictEqual([
        200,
        [],
      ]);
    }).pipe(Effect.provide(served()))
  );

  it.effect(
    "streams progress events beside the elements, each kind in its order",
    () =>
      Effect.gen(function* () {
        const frames = yield* Effect.flatMap(
          call("build", { steps: 2 }),
          framesOf
        );

        const of = (event: string) =>
          frames.filter((frame) => frame.event === event);

        expect([of("element"), of("progress"), frames.length]).toStrictEqual([
          [
            { event: "element", data: { line: "step 1" } },
            { event: "element", data: { line: "step 2" } },
          ],
          [
            { event: "progress", data: { step: 1 } },
            { event: "progress", data: { step: 2 } },
          ],
          4,
        ]);
      }).pipe(Effect.provide(served()))
  );

  it("lists the route's event stream alone", () => {
    const responses = OpenApi.fromApi(Http.api).paths["/api/tail"]?.post
      ?.responses;

    expect(Object.keys(responses?.["200"]?.content ?? {})).toStrictEqual([
      "text/event-stream",
    ]);
  });
});

describe("ActionHttp.client of an action answering a stream", () => {
  it.effect("streams the elements", () =>
    Effect.gen(function* () {
      const client = yield* ActionHttp.client(Http);

      expect(yield* Stream.runCollect(client.tail({ count: 3 }))).toStrictEqual(
        [{ n: 1 }, { n: 2 }, { n: 3 }]
      );
      expect(yield* Stream.runCollect(client.tail({ count: 0 }))).toStrictEqual(
        []
      );
    }).pipe(Effect.provide(served()))
  );

  it.effect("fails with a declared failure after the elements, as typed", () =>
    Effect.gen(function* () {
      const client = yield* ActionHttp.client(Http);
      const seen: number[] = [];

      const exit = yield* Effect.exit(
        Stream.runForEach(client.tail({ count: 2, halt: "after" }), ({ n }) =>
          Effect.sync(() => seen.push(n))
        )
      );

      const before = yield* Effect.exit(
        Stream.runDrain(client.tail({ count: 2, halt: "before" }))
      );

      expect([seen, exit, before]).toStrictEqual([
        [1, 2],
        Exit.fail(new LogGone({ at: 2 })),
        Exit.fail(new LogGone({ at: 0 })),
      ]);
    }).pipe(Effect.provide(served()))
  );

  it.effect("hands progress to onProgress beside the elements", () =>
    Effect.gen(function* () {
      const client = yield* ActionHttp.client(Http);
      const reported: number[] = [];

      const elements = yield* Stream.runCollect(
        client.build(
          { steps: 2 },
          { onProgress: ({ step }) => Effect.sync(() => reported.push(step)) }
        )
      );

      const alone = yield* Stream.runCollect(client.build({ steps: 1 }));

      expect([elements, reported, alone]).toStrictEqual([
        [{ line: "step 1" }, { line: "step 2" }],
        [1, 2],
        [{ line: "step 1" }],
      ]);
    }).pipe(Effect.provide(served()))
  );

  it.effect("fails with a defect where its handler dies after an element", () =>
    Effect.gen(function* () {
      const client = yield* ActionHttp.client(Http);

      const exit = yield* Effect.exit(
        Stream.runDrain(client.tail({ count: 1, halt: "defect" }))
      );

      assert(Exit.isFailure(exit) && Cause.hasDies(exit.cause));
      expect(Cause.pretty(exit.cause)).toContain("Internal server error");
    }).pipe(Effect.provide(served()))
  );

  it.effect("closes the handler's stream once the client stops reading", () =>
    Effect.gen(function* () {
      const released = yield* Deferred.make<undefined>();

      const counted = yield* Effect.gen(function* () {
        const client = yield* ActionHttp.client(Counting);

        return yield* Stream.runCollect(Stream.take(client.count(), 3));
      }).pipe(
        Effect.provide(
          Testing.layer(ActionHttp.layer(Counting, countsReleasing(released)))
        )
      );

      yield* Deferred.await(released);

      expect(counted).toStrictEqual([0, 1, 2]);
    })
  );
});
