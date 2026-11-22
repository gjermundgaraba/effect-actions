import { createServer } from "node:http";

import { NodeHttpServer } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import {
  Context,
  Deferred,
  Duration,
  Effect,
  Exit,
  Fiber,
  Layer,
  Schema,
  Scope,
} from "effect";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientError,
  HttpClientRequest,
  HttpRouter,
  HttpServer,
} from "effect/http";

import * as Action from "../../src/contract/Action.js";
import * as ActionHttp from "../../src/http/ActionHttp.js";

const Hold = Action.make("hold", {
  description: "Answer once released",
  readOnly: false,
  caller: Action.Anyone,
  input: Schema.Struct({}),
  success: Schema.String,
});

const Http = ActionHttp.make([Hold]);

const server = (gracefulShutdownTimeout?: Duration.Input) =>
  NodeHttpServer.layer(createServer, {
    host: "127.0.0.1",
    port: 0,
    ...(gracefulShutdownTimeout === undefined
      ? {}
      : { gracefulShutdownTimeout }),
  });

const built = <E>(layer: Layer.Layer<HttpServer.HttpServer, E>) =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();

    const context = yield* Layer.buildWithScope(layer, scope);

    const url = HttpServer.formatAddress(
      Context.get(context, HttpServer.HttpServer).address
    );

    return { scope, url };
  });

const holding = (gracefulShutdownTimeout: Duration.Input) =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<undefined>();

    const release = yield* Deferred.make<undefined>();

    const app = Action.implement(Hold, () =>
      Effect.andThen(Deferred.succeed(entered, undefined), () =>
        Effect.as(Deferred.await(release), "released")
      )
    );

    const { scope, url } = yield* built(
      HttpRouter.serve(ActionHttp.layer(Http, app), {
        disableLogger: true,
        disableListenLog: true,
      }).pipe(Layer.provideMerge(server(gracefulShutdownTimeout)))
    );

    return { entered, release, scope, url };
  });

const hold = (url: string) =>
  Effect.promise(async () => {
    const started = Date.now();

    let answer:
      | { status: number; retryAfter: string | null; body: string }
      | "no answer";

    try {
      const response = await fetch(`${url}/api/hold`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
        signal: AbortSignal.timeout(3000),
      });

      answer = {
        status: response.status,
        retryAfter: response.headers.get("retry-after"),
        body: await response.text(),
      };
    } catch {
      answer = "no answer";
    }

    return { answer, atOnce: Date.now() - started < 1000 };
  });

describe("a Node server serving ActionHttp as it stops", () => {
  it.live(
    "answers a call in flight once it finishes and refuses a new connection; a call still running at the graceful timeout is answered at once with an empty 503, which is no Action.Unavailable",
    () =>
      Effect.gen(function* () {
        const graceful = yield* holding(Duration.seconds(5));

        const finishing = yield* Effect.forkChild(hold(graceful.url));

        yield* Deferred.await(graceful.entered);

        const stopping = yield* Effect.forkChild(
          Scope.close(graceful.scope, Exit.void)
        );

        yield* Effect.sleep(Duration.millis(200));

        const late = yield* hold(graceful.url);

        yield* Deferred.succeed(graceful.release, undefined);

        const finished = yield* Fiber.join(finishing);

        yield* Fiber.join(stopping);

        expect([finished.answer, late.answer]).toStrictEqual([
          { status: 200, retryAfter: null, body: '"released"' },
          "no answer",
        ]);

        const cut = yield* holding(Duration.millis(300));

        const running = yield* Effect.forkChild(hold(cut.url));

        yield* Deferred.await(cut.entered);

        yield* Scope.close(cut.scope, Exit.void);

        expect(yield* Fiber.join(running)).toStrictEqual({
          answer: { status: 503, retryAfter: null, body: "" },
          atOnce: true,
        });
      }),
    30_000
  );

  it.live(
    "answers a call while it serves no routes with Effect's own text 503 and Retry-After, which the action client fails with as an undeclared answer, not Action.Unavailable",
    () =>
      Effect.gen(function* () {
        const idle = yield* built(server());

        const { answer } = yield* hold(idle.url);

        const called = yield* ActionHttp.client(Http, {
          transformClient: HttpClient.mapRequest(
            HttpClientRequest.prependUrl(idle.url)
          ),
        }).pipe(
          Effect.flatMap((client) => client.hold()),
          Effect.flip,
          Effect.provide(FetchHttpClient.layer)
        );

        yield* Scope.close(idle.scope, Exit.void);

        expect(answer).toStrictEqual({
          status: 503,
          retryAfter: "1",
          body: "service unavailable",
        });
        expect(HttpClientError.isHttpClientError(called)).toBe(true);
      }),
    30_000
  );
});
