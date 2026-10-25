import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, ErrorReporter, Exit, Layer, Schema, Stream } from "effect";
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
import { serve } from "../support/serve.js";

class Halted extends Schema.TaggedError<Halted>()(
  "Halted",
  { at: Schema.Finite },
  { httpApiStatus: 409 },
) {}

const Import = Action.make("importAll", {
  description: "Import every item, reporting how many are done.",
  input: {
    count: Schema.Finite,
    halt: Schema.optional(Schema.Literals(["before", "after", "defect", "unencodable"])),
  },
  success: { imported: Schema.Finite },
  progress: { done: Schema.Finite, total: Schema.Finite },
  error: Halted,
  readOnly: false,
  caller: Action.Anyone,
});

const Touch = Action.make("touch", {
  description: "Touch, reporting once.",
  progress: { touched: Schema.Boolean },
  readOnly: false,
  caller: Action.Anyone,
});

const imports = Action.implement(Import, ({ count, halt }, { progress }) =>
  Effect.gen(function* () {
    if (halt === "before") return yield* new Halted({ at: 0 });

    for (let done = 1; done <= count; done++) yield* progress({ done, total: count });

    if (halt === "after") return yield* new Halted({ at: count });

    if (halt === "defect") return yield* Effect.die(new Error("the import's secret detail"));

    if (halt === "unencodable") return { imported: Number.NaN };

    return { imported: count };
  }),
);

const touches = Action.implement(Touch, (_input, { progress }) => progress({ touched: true }));

const Http = ActionHttp.make([Import, Touch]);

const Guard = Action.make("guarded", {
  description: "Reports to a signed-in caller.",
  progress: { step: Schema.Finite },
  readOnly: true,
  caller: CurrentActor,
});

const Login = Authentication.make("http-progress.Login", CurrentActor);

const authenticate = Authentication.layer(Login, verify);

const guards = Action.implement(Guard, (_input, { progress }) => progress({ step: 1 }), {
  authorize: () => Effect.void,
});

const Guarded = ActionHttp.make([Guard], { authentication: Login });

const served = (reported: Array<string> = []) =>
  Testing.layer(
    ActionHttp.layer(Http, [imports, touches]).pipe(
      Layer.provide(ErrorReporter.layer([recorder(reported)])),
    ),
  );

const Json = Schema.fromJsonString(Schema.Json);

const call = (name: string, body: Schema.Json, stream: boolean) =>
  HttpClient.execute(
    HttpClientRequest.post(`/api/${name}`).pipe(
      HttpClientRequest.bodyJsonUnsafe(body),
      HttpClientRequest.setHeaders(stream ? { accept: "text/event-stream" } : {}),
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

describe("HTTP progress", () => {
  it.effect("streams each value as a progress event, then the answer as a final one", () =>
    Effect.gen(function* () {
      const response = yield* call("importAll", { count: 2 }, true);

      expect([response.status, response.headers["content-type"]]).toEqual([
        200,
        "text/event-stream",
      ]);
      expect(yield* framesOf(response)).toEqual([
        { event: "progress", data: { done: 1, total: 2 } },
        { event: "progress", data: { done: 2, total: 2 } },
        { event: "final", data: { imported: 2 } },
      ]);
    }).pipe(Effect.provide(served())),
  );

  it.effect("answers JSON alone where the request does not accept an event stream", () =>
    Effect.gen(function* () {
      const response = yield* call("importAll", { count: 2 }, false);

      expect([response.status, yield* response.json]).toEqual([200, { imported: 2 }]);
    }).pipe(Effect.provide(served())),
  );

  it.effect(
    "answers a failure before the first event with its own status, as JSON, reported once",
    () => {
      const reported: Array<string> = [];

      return Effect.gen(function* () {
        const response = yield* call("importAll", { count: 2, halt: "before" }, true);

        expect([response.status, yield* response.json]).toEqual([409, { _tag: "Halted", at: 0 }]);
        expect(reported).toEqual([expect.stringContaining("Halted")]);
      }).pipe(Effect.provide(served(reported)));
    },
  );

  it.effect("ends a stream whose handler dies with a failure that says no more, reported", () => {
    const reported: Array<string> = [];

    return Effect.gen(function* () {
      const frames = yield* Effect.flatMap(
        call("importAll", { count: 1, halt: "defect" }, true),
        framesOf,
      );

      expect(frames.slice(0, 1)).toEqual([{ event: "progress", data: { done: 1, total: 1 } }]);
      expect(JSON.stringify(frames.slice(1))).toContain("Internal server error");
      expect(JSON.stringify(frames)).not.toContain("secret detail");
      expect(reported).toEqual([expect.stringContaining("the import's secret detail")]);
    }).pipe(Effect.provide(served(reported)));
  });

  it.effect("ends a stream whose answer does not encode as a defect would, reported", () => {
    const reported: Array<string> = [];

    return Effect.gen(function* () {
      const frames = yield* Effect.flatMap(
        call("importAll", { count: 1, halt: "unencodable" }, true),
        framesOf,
      );

      expect(frames.slice(0, 1)).toEqual([{ event: "progress", data: { done: 1, total: 1 } }]);
      expect(JSON.stringify(frames.slice(1))).toContain("Internal server error");
      expect(JSON.stringify(frames)).not.toContain("Expected");
      expect(reported).toEqual([expect.stringContaining("Expected a finite number")]);
    }).pipe(Effect.provide(served(reported)));
  });

  it.effect("reports a declared failure ending a stream once, as without the stream", () => {
    const reported: Array<string> = [];

    return Effect.gen(function* () {
      const frames = yield* Effect.flatMap(
        call("importAll", { count: 1, halt: "after" }, true),
        framesOf,
      );

      expect(JSON.stringify(frames.slice(1))).toContain("Halted");
      expect(reported).toEqual([expect.stringContaining("Halted")]);

      yield* call("importAll", { count: 1, halt: "after" }, false);

      expect(reported).toEqual([
        expect.stringContaining("Halted"),
        expect.stringContaining("Halted"),
      ]);
    }).pipe(Effect.provide(served(reported)));
  });

  it.effect("answers a refusal before the first event with its status", () =>
    Effect.gen(function* () {
      const response = yield* call("guarded", {}, true);

      expect([response.status, yield* response.json]).toEqual([
        401,
        expect.objectContaining({ _tag: "Unauthenticated" }),
      ]);
    }).pipe(
      Effect.provide(
        Testing.layer(ActionHttp.layer(Guarded, guards).pipe(Layer.provide(authenticate))),
      ),
    ),
  );

  it.effect("answers an empty 500 where its handler dies before the first event", () => {
    const reported: Array<string> = [];

    return Effect.gen(function* () {
      const response = yield* call("importAll", { count: 0, halt: "defect" }, true);

      expect([response.status, yield* response.text]).toEqual([500, ""]);
      expect(reported).toEqual([expect.stringContaining("the import's secret detail")]);
    }).pipe(Effect.provide(served(reported)));
  });

  it.effect("streams an action answering nothing, which answers a 204 without the stream", () =>
    Effect.gen(function* () {
      const frames = yield* Effect.flatMap(call("touch", {}, true), framesOf);
      const plain = yield* call("touch", {}, false);

      expect([frames, plain.status]).toEqual([
        [
          { event: "progress", data: { touched: true } },
          { event: "final", data: null },
        ],
        204,
      ]);
    }).pipe(Effect.provide(served())),
  );

  it("lists the route's JSON answer and its event stream", () => {
    const responses = OpenApi.fromApi(Http.api).paths["/api/importAll"]?.post?.responses;

    expect(Object.keys(responses?.["200"]?.content ?? {})).toEqual([
      "application/json",
      "text/event-stream",
    ]);
  });
});

describe("ActionHttp.client's onProgress", () => {
  it.effect("hands on each value, in order, then answers", () =>
    Effect.gen(function* () {
      const client = yield* ActionHttp.client(Http);
      const seen: Array<number> = [];

      const answer = yield* client.importAll(
        { count: 3 },
        { onProgress: ({ done }) => Effect.sync(() => seen.push(done)) },
      );

      expect([seen, answer]).toEqual([[1, 2, 3], { imported: 3 }]);
    }).pipe(Effect.provide(served())),
  );

  it.effect("asks for the event stream only where the call gives onProgress", () => {
    const web = serve(ActionHttp.layer(Http, [imports, touches]));
    const accepted: Array<string | null> = [];

    return Effect.gen(function* () {
      const client = yield* ActionHttp.client(Http, { baseUrl: "http://localhost" });

      yield* client.importAll({ count: 1 });
      yield* client.importAll({ count: 1 }, { onProgress: () => Effect.void });

      expect(accepted).toEqual([null, "text/event-stream"]);
    }).pipe(
      Effect.provide(
        Testing.layer((request) => {
          accepted.push(request.headers.get("accept"));

          return web.handler(request);
        }),
      ),
    );
  });

  it.effect("fails with a declared failure after its progress, as typed", () =>
    Effect.gen(function* () {
      const client = yield* ActionHttp.client(Http);
      const seen: Array<number> = [];

      const exit = yield* Effect.exit(
        client.importAll(
          { count: 2, halt: "after" },
          { onProgress: ({ done }) => Effect.sync(() => seen.push(done)) },
        ),
      );

      expect(seen).toEqual([1, 2]);
      expect(exit).toEqual(Exit.fail(new Halted({ at: 2 })));
    }).pipe(Effect.provide(served())),
  );

  it.effect("answers alike without onProgress, and an action answering nothing with it", () =>
    Effect.gen(function* () {
      const client = yield* ActionHttp.client(Http);
      const touched: Array<boolean> = [];

      const answers = [
        yield* client.importAll({ count: 2 }),
        yield* client.touch(
          {},
          { onProgress: ({ touched: each }) => Effect.sync(() => touched.push(each)) },
        ),
      ];

      expect([answers, touched]).toEqual([[{ imported: 2 }, undefined], [true]]);
    }).pipe(Effect.provide(served())),
  );

  it.effect("answers where onProgress dies, logging it", () =>
    Effect.gen(function* () {
      const client = yield* ActionHttp.client(Http);

      const answer = yield* client.importAll(
        { count: 2 },
        { onProgress: () => Effect.die(new Error("the page broke")) },
      );

      expect(answer).toEqual({ imported: 2 });
    }).pipe(Effect.provide(served())),
  );

  it.effect("fails with a defect where its handler dies after its progress", () =>
    Effect.gen(function* () {
      const client = yield* ActionHttp.client(Http);

      const exit = yield* Effect.exit(
        client.importAll({ count: 1, halt: "defect" }, { onProgress: () => Effect.void }),
      );

      expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true);
    }).pipe(Effect.provide(served())),
  );
});
