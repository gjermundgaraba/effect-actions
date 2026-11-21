import { describe, expect, it } from "@effect/vitest";
import * as ActionMcp from "@gjermundgaraba/effect-actions/ActionMcp";
import { evictDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import {
  Deferred,
  Effect,
  Exit,
  Fiber,
  Option,
  Result,
  Schema,
  Stream,
} from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import type { HttpClientResponse } from "effect/http";

import { forwarding } from "../../src/host/mcp.js";
import { logged, throughWorker } from "../support/worker.js";

const url = "https://worker.example/mcp";

const alice = { authorization: "Bearer alice" };

const stateless = (method: string, params: ActionMcp.Params = {}) =>
  HttpClient.execute(
    ActionMcp.request(method, params, { url, headers: alice })
  );

const inSession = (
  message: { readonly method: string; readonly params: Schema.Json },
  session?: string,
  id = 1
) =>
  HttpClient.execute(
    HttpClientRequest.post(url).pipe(
      HttpClientRequest.setHeaders({
        accept: "application/json, text/event-stream",
        ...alice,
        ...(session === undefined ? {} : { "mcp-session-id": session }),
      }),
      HttpClientRequest.bodyJsonUnsafe({ jsonrpc: "2.0", id, ...message })
    )
  );

const initialize = {
  method: "initialize",
  params: {
    protocolVersion: "2025-11-25",
    capabilities: {},
    clientInfo: { name: "tests", version: "0" },
  },
};

const listing = { method: "tools/list", params: {} };

const opened = Effect.gen(function* () {
  const response = yield* inSession(initialize);

  yield* response.text;

  const session = response.headers["mcp-session-id"] ?? "";
  const [object = "", server = ""] = session.split(".");

  return { status: response.status, session, object, server };
});

const Called = Schema.fromJsonString(
  Schema.Struct({
    result: Schema.Struct({
      content: Schema.Array(Schema.Struct({ text: Schema.String })),
    }),
  })
);

const textsOf = (response: HttpClientResponse.HttpClientResponse) =>
  response.text.pipe(
    Effect.flatMap(Schema.decodeEffect(Called)),
    Effect.map(({ result }) => result.content.map(({ text }) => text))
  );

const active = "notifications/events/active";

const readUntil = (
  response: HttpClientResponse.HttpClientResponse,
  found: string,
  streaming: Deferred.Deferred<string>
) =>
  response.stream.pipe(
    Stream.decodeText,
    Stream.scan(
      () => "",
      (text, chunk) => text + chunk
    ),
    Stream.tap((text) =>
      text.includes(active) ? Deferred.succeed(streaming, text) : Effect.void
    ),
    Stream.takeUntil((text) => text.includes(found)),
    Stream.runLast,
    Effect.map(Option.getOrElse(() => ""))
  );

const builds = HttpClient.get("https://worker.example/mcp-builds").pipe(
  Effect.flatMap((response) => response.json),
  Effect.flatMap(
    Schema.decodeUnknownEffect(Schema.Struct({ built: Schema.Int }))
  ),
  Effect.map(({ built }) => built)
);

const webPost = (body: Schema.Json, session?: string) =>
  new Request(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...alice,
      ...(session === undefined ? {} : { "mcp-session-id": session }),
    },
    body: JSON.stringify(body),
  });

const forwarded = (
  forward: ReturnType<typeof forwarding>,
  body: Schema.Json,
  session?: string
) =>
  Effect.promise(async () => {
    const response = await forward(webPost(body, session), env.MCP_ENDPOINT);

    await response.text();

    return {
      status: response.status,
      session: response.headers.get("mcp-session-id") ?? "",
    };
  });

const listing2026 = () =>
  Result.getOrThrow(
    HttpClientRequest.toWebResult(
      ActionMcp.request("tools/list", {}, { url, headers: alice })
    )
  );

const signal = (path: string) =>
  Effect.flatMap(
    HttpClient.get(`https://worker.example${path}`),
    (response) => response.text
  );

describe("ActionWorker's MCP endpoint", () => {
  it.live(
    "opens a 2025 session named for its object, serves its calls there with the caller's credential, and ends it",
    () =>
      Effect.gen(function* () {
        const { status, session, object, server } = yield* opened;

        const called = yield* inSession(
          {
            method: "tools/call",
            params: { name: "whoami", arguments: { room: "mcp-session" } },
          },
          session,
          2
        );

        const ended = yield* HttpClient.execute(
          HttpClientRequest.delete(url).pipe(
            HttpClientRequest.setHeaders({
              ...alice,
              "mcp-session-id": session,
              "mcp-protocol-version": "2025-11-25",
            })
          )
        );

        const after = yield* inSession(listing, session, 3);

        expect(status).toBe(200);
        expect(env.MCP_ENDPOINT.idFromString(object).toString()).toBe(object);
        expect(server).toMatch(/^[\da-f-]{36}$/u);
        expect(yield* textsOf(called)).toStrictEqual(["Bearer alice"]);
        expect(ended.status).toBe(204);
        expect(after.status).toBe(404);
      }).pipe(Effect.provide(throughWorker))
  );

  it.live(
    "answers 404 to a session naming no object, an object that is no id, or one that never opened it",
    () =>
      Effect.gen(function* () {
        const sessions = [
          "a1b2c3",
          "nonsense.a1b2c3",
          `${env.MCP_ENDPOINT.newUniqueId().toString()}.a1b2c3`,
        ];

        const statuses = yield* Effect.forEach(sessions, (session) =>
          Effect.map(inSession(listing, session), ({ status }) => status)
        );

        expect(statuses).toStrictEqual([404, 404, 404]);
      }).pipe(Effect.provide(throughWorker))
  );

  it.live(
    "pushes an entity's event on a 2026-07-28 stream through the Worker",
    () =>
      Effect.gen(function* () {
        const room = "mcp-stream";
        const streaming = yield* Deferred.make<string>();

        const stream = yield* stateless("events/stream", {
          name: "seen",
          arguments: { room },
        });

        const pushed = yield* Effect.forkChild(
          readUntil(stream, "notifications/events/event", streaming)
        );

        yield* Deferred.await(streaming);

        yield* Effect.flatMap(
          stateless("tools/call", { name: "whoami", arguments: { room } }),
          (response) => response.text
        );

        expect(stream.headers["content-type"]).toBe("text/event-stream");
        expect(yield* Fiber.join(pushed)).toContain('"data":{"by":"alice"}');
      }).pipe(Effect.scoped, Effect.provide(throughWorker)),
    { timeout: 30_000 }
  );

  it.live(
    "lets its object be evicted once a client drops its stream, losing its sessions, and serves the next request in a new one",
    () =>
      Effect.gen(function* () {
        const { session, object } = yield* opened;
        const streaming = yield* Deferred.make<string>();

        yield* Effect.scoped(
          Effect.flatMap(
            stateless("events/stream", {
              name: "seen",
              arguments: { room: "mcp-dropped" },
            }),
            (stream) => readUntil(stream, active, streaming)
          )
        );

        yield* Effect.promise(async () => {
          await evictDurableObject(
            env.MCP_ENDPOINT.get(env.MCP_ENDPOINT.idFromString(object))
          );
        });

        const lost = yield* inSession(listing, session, 2);

        const listed = yield* stateless("tools/list");

        yield* listed.text;

        expect(lost.status).toBe(404);
        expect(listed.status).toBe(200);
      }).pipe(Effect.provide(throughWorker)),
    { timeout: 30_000 }
  );

  it.live(
    "sends a session's later request, from another isolate's forwarder, to the object that opened it",
    () =>
      Effect.gen(function* () {
        const opening = forwarding();
        const other = forwarding();

        const { session } = yield* forwarded(opening, {
          jsonrpc: "2.0",
          id: 1,
          ...initialize,
        });

        const elsewhere = yield* forwarded(other, {
          jsonrpc: "2.0",
          id: 1,
          ...initialize,
        });

        const listed = yield* forwarded(
          other,
          { jsonrpc: "2.0", id: 2, ...listing },
          session
        );

        expect(elsewhere.session.split(".")[0]).not.toBe(session.split(".")[0]);
        expect(listed.status).toBe(200);
      })
  );

  it.live(
    "runs each request with the services the routes merge, such as their logger, as a route's",
    () =>
      Effect.gen(function* () {
        yield* logged;

        const listed = yield* stateless("tools/list");

        yield* listed.text;

        expect(yield* logged).toContain('["mcp request"]');
      }).pipe(Effect.provide(throughWorker))
  );

  it.live(
    "builds an object's endpoint once for requests arriving together",
    () =>
      Effect.gen(function* () {
        const forward = forwarding();
        const before = yield* builds;

        const statuses = yield* Effect.promise(
          async () =>
            await Promise.all(
              [listing2026(), listing2026()].map(async (request) => {
                const response = await forward(request, env.MCP_ENDPOINT);

                await response.text();

                return response.status;
              })
            )
        );

        expect(statuses).toStrictEqual([200, 200]);
        expect((yield* builds) - before).toBe(1);
      }).pipe(Effect.provide(throughWorker))
  );

  it.live(
    "builds an endpoint again on the request after its build failed",
    () =>
      Effect.gen(function* () {
        const forward = forwarding();
        const before = yield* builds;

        yield* signal("/fail-mcp-build");

        const failed = yield* Effect.exit(
          Effect.tryPromise(
            async () => await forward(listing2026(), env.MCP_ENDPOINT)
          )
        );

        const after = yield* Effect.promise(async () => {
          const response = await forward(listing2026(), env.MCP_ENDPOINT);

          await response.text();

          return response.status;
        });

        expect(Exit.isFailure(failed)).toBe(true);
        expect(after).toBe(200);
        expect((yield* builds) - before).toBe(2);
      }).pipe(Effect.provide(throughWorker))
  );
});
