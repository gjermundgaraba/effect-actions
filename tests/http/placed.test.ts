import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Exit, Fiber, Layer, Stream } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import * as Action from "../../src/contract/Action.js";
import * as ActionHttp from "../../src/http/ActionHttp.js";
import * as Testing from "../../src/testing/Testing.js";
import { authenticate } from "../support/app/authentication.js";
import { actors, CurrentActor } from "../support/app/authorization.js";
import { UserNotFound } from "../support/app/contracts.js";
import { Counted, Placed, target } from "../support/placed.js";

const worker = (placed: ReturnType<typeof target>["placed"]) =>
  Testing.layer(ActionHttp.layer(Placed, placed).pipe(Layer.provide(authenticate)));

const signedInAs = (token: string, headers: Record<string, string> = {}) =>
  ActionHttp.client(Placed, {
    transformClient: HttpClient.mapRequest((request) =>
      HttpClientRequest.setHeaders(HttpClientRequest.bearerToken(request, token), headers),
    ),
  });

describe("ActionHttp.placed", () => {
  it.effect(
    "answers each placed action as the server reached answers it, sending the caller's headers on but its request's own",
    () =>
      Effect.gen(function* () {
        const reached = target();

        const answered = yield* Effect.gen(function* () {
          const client = yield* signedInAs("alice", {
            "x-trace": "t1",
            "mcp-method": "tools/call",
          });

          return {
            found: yield* client.getUser({ id: "1" }),
            missing: yield* Effect.flip(client.getUser({ id: "9" })),
          };
        }).pipe(Effect.provide(worker(reached.placed)));

        const [first] = reached.requests;

        expect(answered).toEqual({
          found: { id: "1", name: "Ada" },
          missing: new UserNotFound({ id: "9" }),
        });
        expect(reached.requests.map(({ url }) => url)).toEqual([
          "http://localhost/api/getUser",
          "http://localhost/api/getUser",
        ]);
        expect(first?.headers.get("authorization")).toBe("Bearer alice");
        expect(first?.headers.get("x-trace")).toBe("t1");
        expect(first?.headers.has("mcp-method")).toBe(false);
        expect(yield* Effect.promise(async () => first?.json())).toEqual({ id: "1" });
      }),
  );

  it.effect("sends a header its client sets in place of the caller's of that name", () =>
    Effect.gen(function* () {
      const reached = target();

      yield* Effect.flatMap(signedInAs("alice", { "x-tenant": "caller's" }), (client) =>
        client.getUser({ id: "1" }),
      ).pipe(
        Effect.provide(
          worker(
            ActionHttp.placed(Placed, () =>
              HttpClient.mapRequest(reached.client, HttpClientRequest.setHeader("x-tenant", "own")),
            ),
          ),
        ),
      );

      expect(reached.requests.map((request) => request.headers.get("x-tenant"))).toEqual(["own"]);
    }),
  );

  it.effect(
    "passes back a placed action's stream element by element, and its progress before its answer where the caller reads it",
    () =>
      Effect.gen(function* () {
        const reached = target();
        const reported: Array<number> = [];

        const answered = yield* Effect.gen(function* () {
          const client = yield* signedInAs("alice");

          return {
            counted: yield* Stream.runCollect(client.countdown({ from: 3 })),
            filled: yield* client.fill(
              { slots: 2 },
              { onProgress: ({ slot }) => Effect.sync(() => reported.push(slot)) },
            ),
            unread: yield* client.fill({ slots: 1 }),
          };
        }).pipe(Effect.provide(worker(reached.placed)));

        expect({ ...answered, reported }).toEqual({
          counted: [3, 2, 1],
          filled: { filled: 2 },
          unread: { filled: 1 },
          reported: [1, 2],
        });
        expect(
          reached.requests
            .filter(({ url }) => url.endsWith("/fill"))
            .map((request) => (request.headers.get("accept") ?? "").includes("text/event-stream")),
        ).toEqual([true, false]);
      }),
  );

  it.effect(
    "refuses a caller without a credential itself, sending nothing on, and passes back the refusal of the server reached",
    () =>
      Effect.gen(function* () {
        const reached = target();

        const refused = yield* Effect.gen(function* () {
          const anonymous = yield* ActionHttp.client(Placed);
          const reader = yield* signedInAs("reader");

          return {
            anonymous: yield* Effect.flip(anonymous.getUser({ id: "1" })),
            reader: yield* Effect.flip(reader.renameUser({ id: "1", name: "Grace" })),
          };
        }).pipe(Effect.provide(worker(reached.placed)));

        expect(refused.anonymous).toBeInstanceOf(Action.Unauthenticated);
        expect(refused.reader).toEqual(
          new Action.Forbidden({ message: "Requires users:write.", scopes: ["users:write"] }),
        );
        expect(reached.requests.map(({ url }) => url)).toEqual(["http://localhost/api/renameUser"]);
      }),
  );

  it.live(
    "follows a placed event as the server reached sends it, its value and then each change",
    () =>
      Effect.gen(function* () {
        const reached = target();
        const streamed: Array<unknown> = [];

        const polled = yield* Effect.gen(function* () {
          const client = yield* signedInAs("alice");

          const watching = yield* client.watch(Counted).pipe(
            Stream.runForEach((item) =>
              Effect.sync(() => streamed.push(item._tag === "Gap" ? "gap" : item.data)),
            ),
            Effect.forkChild,
          );

          const page = yield* client
            .watch(Counted, {}, { mode: "poll" })
            .pipe(Stream.take(1), Stream.runCollect);

          yield* Effect.sleep("10 millis").pipe(
            Effect.repeat({ while: () => streamed.length === 0 }),
          );
          yield* client.bump();
          yield* Effect.sleep("10 millis").pipe(
            Effect.repeat({ while: () => streamed.length < 2 }),
          );
          yield* Fiber.interrupt(watching);

          return page.map((item) => (item._tag === "Gap" ? "gap" : item.data));
        }).pipe(Effect.provide(worker(reached.placed)), Effect.timeout("5 seconds"));

        expect(polled).toEqual([{ count: 0 }]);
        expect(streamed).toEqual([{ count: 0 }, { count: 1 }]);
      }),
  );

  it.effect("dies naming the action where the server reached does not serve it", () =>
    Effect.gen(function* () {
      const reached = target({ withoutDouble: true });
      const client = yield* Action.client(reached.placed);
      const exit = yield* Effect.exit(client.double({ value: 2 }));

      expect(Exit.isFailure(exit) && Cause.squash(exit.cause)).toEqual(
        new Error(
          "ActionHttp.placed: the server its client reaches does not serve double (serve its implementation in that server's ActionHttp.layer of this binding)",
        ),
      );
    }).pipe(Effect.provideService(CurrentActor, actors.alice)),
  );
});
