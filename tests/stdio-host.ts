// A host of a stdio MCP server in memory, for tests reading what the server writes: it speaks
// one revision, sends each request once the one before is answered, then closes stdin.
import { Deferred, Effect, Option, Predicate, Schema, Sink, Stdio, Stream } from "effect";
import { httpProtocol, type Params, statelessRequest } from "../src/internal/mcp.js";

/** A request the host sends: its method and parameters. */
export interface HostRequest {
  readonly method: string;
  readonly params?: Params;
}

const idOf = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ id: Schema.Finite })),
);

/**
 * The JSON-RPC message of the request `id` over `revision`. A 2026-07-28 request carries its
 * client metadata in `_meta`, as a stateless one does; an earlier revision's session has it.
 */
const message = (revision: string, id: number, { method, params = {} }: HostRequest) =>
  revision === httpProtocol.protocolVersion
    ? { ...statelessRequest(method, params).body, id }
    : { jsonrpc: "2.0", id, method, params };

/** What a session of an earlier revision opens with, as id 0. */
const initialize = (revision: string): HostRequest => ({
  method: "initialize",
  params: {
    protocolVersion: revision,
    capabilities: {},
    clientInfo: { name: "test", version: "0" },
  },
});

/** Whether a host speaking `revision` sends each request alone, without a session. */
const isStateless = (revision: string) => revision === httpProtocol.protocolVersion;

/**
 * Run `server` for a host speaking `revision`, and send it `requests`, as ids 1 on: before
 * 2026-07-28, after the session's `initialize`, as id 0. Succeeds with the line the server
 * answered each with, `initialize` included, once it has ended.
 */
const exchange = <E>(
  server: Effect.Effect<void, E, Stdio.Stdio>,
  revision: string,
  requests: ReadonlyArray<HostRequest>,
): Effect.Effect<ReadonlyArray<string>, E> =>
  Effect.gen(function* () {
    const stateless = isStateless(revision);

    const sent = [
      ...(stateless ? [] : [{ id: 0, request: initialize(revision) }]),
      ...requests.map((request, index) => ({ id: index + 1, request })),
    ];

    const pending = yield* Effect.forEach(sent, ({ id, request }) =>
      Effect.map(Deferred.make<string>(), (reply) => ({ id, request, reply })),
    );

    // Each request, then its reply awaited; `initialize` is followed by the notification
    // that the host is initialized.
    const stdin = Stream.fromIterable(pending).pipe(
      Stream.flatMap(({ id, request, reply }) =>
        Stream.concat(
          Stream.make(
            `${JSON.stringify(message(revision, id, request))}\n`,
            ...(id === 0
              ? [`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`]
              : []),
          ),
          Stream.fromEffectDrain(Deferred.await(reply)),
        ),
      ),
      Stream.encodeText,
    );

    const decoder = new TextDecoder();
    let written = "";

    // Every complete line written: a reply resolves the request of its id.
    const stdout = () =>
      Sink.forEach((chunk: string | Uint8Array) =>
        Effect.suspend(() => {
          written += Predicate.isString(chunk) ? chunk : decoder.decode(chunk, { stream: true });

          const complete = written.split("\n");

          written = complete.pop() ?? "";

          return Effect.forEach(
            complete,
            (line) => {
              const reply = Option.flatMap(idOf(line), ({ id }) =>
                Option.fromNullishOr(pending.find((entry) => entry.id === id)),
              );

              return Option.isSome(reply) ? Deferred.succeed(reply.value.reply, line) : Effect.void;
            },
            { discard: true },
          );
        }),
      );

    yield* server.pipe(Effect.provide(Stdio.layerTest({ stdin, stdout })));

    return yield* Effect.forEach(pending, ({ reply }) => Deferred.await(reply));
  });

/**
 * Run `server`, a program on `Stdio` such as `ActionMcp.runStdio`, for a host speaking
 * `revision`, and send it `requests`, as ids 1 on: before 2026-07-28, after the session's
 * `initialize`. Succeeds with the line the server answered each request with, once it has
 * ended, which it does when stdin closes after the last answer.
 */
export const converse = <E>(
  server: Effect.Effect<void, E, Stdio.Stdio>,
  revision: string,
  requests: ReadonlyArray<HostRequest>,
): Effect.Effect<ReadonlyArray<string>, E> =>
  Effect.map(exchange(server, revision, requests), (lines) =>
    isStateless(revision) ? lines : lines.slice(1),
  );

/** The line `server` answers the `initialize` of a host asking for `revision` with. */
export const negotiate = <E>(
  server: Effect.Effect<void, E, Stdio.Stdio>,
  revision: string,
): Effect.Effect<string, E> => Effect.map(exchange(server, revision, []), ([line = ""]) => line);
