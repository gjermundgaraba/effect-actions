import { describe, expect, it } from "@effect/vitest";
import { Cause, Deferred, Effect, ErrorReporter, Exit, Layer, Schema, Stream } from "effect";
import { Sse } from "effect/encoding";
import { HttpClient, HttpClientRequest, type HttpClientResponse } from "effect/http";
import { OpenApi } from "effect/http-api";
import * as Action from "../../src/contract/Action.js";
import * as Authentication from "../../src/authentication/Authentication.js";
import * as ActionHttp from "../../src/http/ActionHttp.js";
import * as Testing from "../../src/testing/Testing.js";
import { verify } from "../support/app/authentication.js";
import { CurrentActor } from "../support/app/authorization.js";
import { recorder } from "../support/reporter.js";

class LogGone extends Schema.TaggedError<LogGone>()(
  "LogGone",
  { at: Schema.Finite },
  { httpApiStatus: 410 },
) {}

const Tail = Action.make("tail", {
  description: "Follow a log, line by line.",
  input: {
    count: Schema.Finite,
    halt: Schema.optional(Schema.Literals(["before", "after", "defect", "unencodable"])),
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

const lines = (count: number) => Stream.map(Stream.range(1, count), (n) => ({ n }));

const tails = Action.implement(Tail, ({ count, halt }) => {
  if (halt === "before") return Stream.fail(new LogGone({ at: 0 }));

  if (halt === "after") return Stream.concat(lines(count), Stream.fail(new LogGone({ at: count })));

  if (halt === "defect")
    return Stream.concat(lines(count), Stream.die(new Error("the log's secret detail")));

  if (halt === "unencodable") return Stream.concat(lines(count), Stream.make({ n: Number.NaN }));

  return lines(count);
});

const builds = Action.implement(Build, ({ steps }, { progress }) =>
  Stream.mapEffect(Stream.range(1, steps), (step) =>
    Effect.as(progress({ step }), { line: `step ${step}` }),
  ),
);

const Http = ActionHttp.make([Tail, Build]);

const Count = Action.make("count", {
  description: "Count until the caller stops reading.",
  success: Action.Stream(Schema.Finite),
  readOnly: true,
  caller: Action.Anyone,
});

const countsReleasing = (released: Deferred.Deferred<void>) =>
  Action.implement(Count, () =>
    Stream.concat(
      Stream.fromEffect(
        Effect.as(
          Effect.addFinalizer(() => Deferred.succeed(released, undefined)),
          0,
        ),
      ),
      Stream.iterate(1, (n) => n + 1),
    ),
  );

const Counting = ActionHttp.make([Count]);

const Follow = Action.make("follow", {
  description: "Follow a signed-in caller's log.",
  success: Action.Stream({ n: Schema.Finite }),
  readOnly: true,
  caller: CurrentActor,
});

const Login = Authentication.make("http-stream.Login", CurrentActor);

const follows = Action.implement(Follow, () => lines(1), { authorize: () => Effect.void });

const Guarded = ActionHttp.make([Follow], { authentication: Login });

const served = (reported: Array<string> = []) =>
  Testing.layer(
    ActionHttp.layer(Http, [tails, builds]).pipe(
      Layer.provide(ErrorReporter.layer([recorder(reported)])),
    ),
  );

const Json = Schema.fromJsonString(Schema.Json);

const call = (name: string, body: Schema.Json) =>
  HttpClient.execute(
    HttpClientRequest.post(`/api/${name}`).pipe(
      HttpClientRequest.bodyJsonUnsafe(body),
      HttpClientRequest.setHeaders({ accept: "text/event-stream" }),
    ),
  );

const framesOf = (response: HttpClientResponse.HttpClientResponse) =>
  response.stream.pipe(
    Stream.decodeText,
    Stream.pipeThroughChannel(Sse.decode()),
    Stream.map((frame) => ({
      event: frame.event,
      data: Schema.decodeUnknownSync(Json)(frame.data),
    })),
    Stream.runCollect,
  );

describe("HTTP element streams", () => {
  it.effect("streams each element as an element event", () =>
    Effect.gen(function* () {
      const response = yield* call("tail", { count: 2 });

      expect([response.status, response.headers["content-type"]]).toEqual([
        200,
        "text/event-stream",
      ]);
      expect(yield* framesOf(response)).toEqual([
        { event: "element", data: { n: 1 } },
        { event: "element", data: { n: 2 } },
      ]);
    }).pipe(Effect.provide(served())),
  );

  it.effect("streams without asking for an event stream, there being no other answer", () =>
    Effect.gen(function* () {
      const response = yield* HttpClient.execute(
        HttpClientRequest.post("/api/tail").pipe(HttpClientRequest.bodyJsonUnsafe({ count: 1 })),
      );

      expect(yield* framesOf(response)).toEqual([{ event: "element", data: { n: 1 } }]);
    }).pipe(Effect.provide(served())),
  );

  it.effect("answers a stream of no element with a 200 and no event", () =>
    Effect.gen(function* () {
      const response = yield* call("tail", { count: 0 });

      expect([response.status, yield* framesOf(response)]).toEqual([200, []]);
    }).pipe(Effect.provide(served())),
  );

  it.effect("streams progress events beside the elements, each kind in its order", () =>
    Effect.gen(function* () {
      const frames = yield* Effect.flatMap(call("build", { steps: 2 }), framesOf);

      const of = (event: string) => frames.filter((frame) => frame.event === event);

      expect([of("element"), of("progress"), frames.length]).toEqual([
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
    }).pipe(Effect.provide(served())),
  );

  it.effect(
    "answers a failure before the first event with its own status, as JSON, reported once",
    () => {
      const reported: Array<string> = [];

      return Effect.gen(function* () {
        const response = yield* call("tail", { count: 2, halt: "before" });

        expect([response.status, yield* response.json]).toEqual([410, { _tag: "LogGone", at: 0 }]);
        expect(reported).toEqual([expect.stringContaining("LogGone")]);
      }).pipe(Effect.provide(served(reported)));
    },
  );

  it.effect("ends a stream with a declared failure after its elements, reported once", () => {
    const reported: Array<string> = [];

    return Effect.gen(function* () {
      const frames = yield* Effect.flatMap(call("tail", { count: 1, halt: "after" }), framesOf);

      expect(frames.slice(0, 1)).toEqual([{ event: "element", data: { n: 1 } }]);
      expect(JSON.stringify(frames.slice(1))).toContain("LogGone");
      expect(reported).toEqual([expect.stringContaining("LogGone")]);
    }).pipe(Effect.provide(served(reported)));
  });

  it.effect("ends a stream whose handler dies with a failure that says no more, reported", () => {
    const reported: Array<string> = [];

    return Effect.gen(function* () {
      const frames = yield* Effect.flatMap(call("tail", { count: 1, halt: "defect" }), framesOf);

      expect(frames.slice(0, 1)).toEqual([{ event: "element", data: { n: 1 } }]);
      expect(JSON.stringify(frames.slice(1))).toContain("Internal server error");
      expect(JSON.stringify(frames)).not.toContain("secret detail");
      expect(reported).toEqual([expect.stringContaining("the log's secret detail")]);
    }).pipe(Effect.provide(served(reported)));
  });

  it.effect("ends a stream at an element that does not encode as a defect would, reported", () => {
    const reported: Array<string> = [];

    return Effect.gen(function* () {
      const frames = yield* Effect.flatMap(
        call("tail", { count: 1, halt: "unencodable" }),
        framesOf,
      );

      expect(frames.slice(0, 1)).toEqual([{ event: "element", data: { n: 1 } }]);
      expect(JSON.stringify(frames.slice(1))).toContain("Internal server error");
      expect(JSON.stringify(frames)).not.toContain("Expected");
      expect(reported).toEqual([expect.stringContaining("Expected a finite number")]);
    }).pipe(Effect.provide(served(reported)));
  });

  it.effect("answers an empty 500 where its handler dies before the first event", () => {
    const reported: Array<string> = [];

    return Effect.gen(function* () {
      const response = yield* call("tail", { count: 0, halt: "defect" });

      expect([response.status, yield* response.text]).toEqual([500, ""]);
      expect(reported).toEqual([expect.stringContaining("the log's secret detail")]);
    }).pipe(Effect.provide(served(reported)));
  });

  it.effect("answers a refusal before the first event with its status", () =>
    Effect.gen(function* () {
      const response = yield* call("follow", {});

      expect(response.status).toBe(401);
      expect(Schema.decodeUnknownSync(Action.Unauthenticated)(yield* response.json)).toEqual(
        new Action.Unauthenticated(),
      );
    }).pipe(
      Effect.provide(
        Testing.layer(
          ActionHttp.layer(Guarded, follows).pipe(
            Layer.provide(Authentication.layer(Login, verify)),
          ),
        ),
      ),
    ),
  );

  it("lists the route's event stream alone", () => {
    const responses = OpenApi.fromApi(Http.api).paths["/api/tail"]?.post?.responses;

    expect(Object.keys(responses?.["200"]?.content ?? {})).toEqual(["text/event-stream"]);
  });
});

describe("ActionHttp.client of an action answering a stream", () => {
  it.effect("streams the elements", () =>
    Effect.gen(function* () {
      const client = yield* ActionHttp.client(Http);

      expect(yield* Stream.runCollect(client.tail({ count: 3 }))).toEqual([
        { n: 1 },
        { n: 2 },
        { n: 3 },
      ]);
      expect(yield* Stream.runCollect(client.tail({ count: 0 }))).toEqual([]);
    }).pipe(Effect.provide(served())),
  );

  it.effect("fails with a declared failure after the elements, as typed", () =>
    Effect.gen(function* () {
      const client = yield* ActionHttp.client(Http);
      const seen: Array<number> = [];

      const exit = yield* Effect.exit(
        Stream.runForEach(client.tail({ count: 2, halt: "after" }), ({ n }) =>
          Effect.sync(() => seen.push(n)),
        ),
      );

      const before = yield* Effect.exit(Stream.runDrain(client.tail({ count: 2, halt: "before" })));

      expect([seen, exit, before]).toEqual([
        [1, 2],
        Exit.fail(new LogGone({ at: 2 })),
        Exit.fail(new LogGone({ at: 0 })),
      ]);
    }).pipe(Effect.provide(served())),
  );

  it.effect("hands progress to onProgress beside the elements", () =>
    Effect.gen(function* () {
      const client = yield* ActionHttp.client(Http);
      const reported: Array<number> = [];

      const elements = yield* Stream.runCollect(
        client.build(
          { steps: 2 },
          { onProgress: ({ step }) => Effect.sync(() => reported.push(step)) },
        ),
      );

      const alone = yield* Stream.runCollect(client.build({ steps: 1 }));

      expect([elements, reported, alone]).toEqual([
        [{ line: "step 1" }, { line: "step 2" }],
        [1, 2],
        [{ line: "step 1" }],
      ]);
    }).pipe(Effect.provide(served())),
  );

  it.effect("fails with a defect where its handler dies after an element", () =>
    Effect.gen(function* () {
      const client = yield* ActionHttp.client(Http);

      const exit = yield* Effect.exit(Stream.runDrain(client.tail({ count: 1, halt: "defect" })));

      expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true);
    }).pipe(Effect.provide(served())),
  );

  it.effect("closes the handler's stream once the client stops reading", () =>
    Effect.gen(function* () {
      const released = yield* Deferred.make<void>();

      const counted = yield* Effect.gen(function* () {
        const client = yield* ActionHttp.client(Counting);

        return yield* Stream.runCollect(Stream.take(client.count(), 3));
      }).pipe(Effect.provide(Testing.layer(ActionHttp.layer(Counting, countsReleasing(released)))));

      yield* Deferred.await(released);

      expect(counted).toEqual([0, 1, 2]);
    }),
  );
});
