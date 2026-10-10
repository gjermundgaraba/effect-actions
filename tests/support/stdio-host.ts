import { Deferred, Effect, Option, Predicate, Schema, Sink, Stdio, Stream } from "effect";
import { httpProtocol, type Params, statelessRequest } from "../../src/mcp/protocol.js";

export interface HostRequest {
  readonly method: string;
  readonly params?: Params;
}

const idOf = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ id: Schema.Finite })),
);

const message = (revision: string, id: number, { method, params = {} }: HostRequest) =>
  revision === httpProtocol.protocolVersion
    ? { ...statelessRequest(method, params).body, id }
    : { jsonrpc: "2.0", id, method, params };

const sessionInitialize = (revision: string): HostRequest => ({
  method: "initialize",
  params: {
    protocolVersion: revision,
    capabilities: {},
    clientInfo: { name: "test", version: "0" },
  },
});

const isStateless = (revision: string) => revision === httpProtocol.protocolVersion;

const exchange = <E>(
  server: Effect.Effect<void, E, Stdio.Stdio>,
  revision: string,
  requests: ReadonlyArray<HostRequest>,
): Effect.Effect<ReadonlyArray<string>, E> =>
  Effect.gen(function* () {
    const stateless = isStateless(revision);

    const sent = [
      ...(stateless ? [] : [{ id: 0, request: sessionInitialize(revision) }]),
      ...requests.map((request, index) => ({ id: index + 1, request })),
    ];

    const pending = yield* Effect.forEach(sent, ({ id, request }) =>
      Effect.map(Deferred.make<string>(), (reply) => ({ id, request, reply })),
    );

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

export const converse = <E>(
  server: Effect.Effect<void, E, Stdio.Stdio>,
  revision: string,
  requests: ReadonlyArray<HostRequest>,
): Effect.Effect<ReadonlyArray<string>, E> =>
  Effect.map(exchange(server, revision, requests), (lines) =>
    isStateless(revision) ? lines : lines.slice(1),
  );

export const negotiate = <E>(
  server: Effect.Effect<void, E, Stdio.Stdio>,
  revision: string,
): Effect.Effect<string, E> => Effect.map(exchange(server, revision, []), ([line = ""]) => line);
