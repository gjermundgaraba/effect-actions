import * as ActionRpc from "@gjermundgaraba/effect-actions/ActionRpc";
import {
  Cause,
  Duration,
  Effect,
  Exit,
  Fiber,
  Option,
  Predicate,
  Schema,
} from "effect";
import { Rpc, RpcMessage, RpcSerialization } from "effect/rpc";

import { closeQuietly, died, encodeDefect, parser, send } from "./frames.js";

const Header = Schema.Tuple([Schema.String, Schema.String]);

const Headers = Schema.Array(Header);

type Headers = typeof Headers.Type;

const RequestId = Schema.Union([Schema.String, Schema.Finite]);

type RequestId = typeof RequestId.Type;

const Parked = Schema.Struct({
  id: RequestId,
  tag: Schema.String,
  payload: Schema.Json,
  headers: Headers,
  gate: Schema.Finite,
});

type Parked = typeof Parked.Type;

const Answered = Schema.Struct({
  watch: Schema.String,
  cursor: Schema.String,
  fingerprint: Schema.optionalKey(Schema.String),
  gate: Schema.Finite,
  at: Schema.Finite,
});

const Attachment = Schema.Struct({
  name: Schema.String,
  version: Schema.NullOr(Schema.String).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(null))
  ),
  headers: Headers,
  calls: Schema.Array(RequestId),
  parked: Schema.Array(Parked),
  answered: Schema.Array(Answered),
});

type Attachment = typeof Attachment.Type;

const decodeAttachment = Schema.decodeUnknownOption(Attachment);

const attachmentOf = (socket: WebSocket) =>
  Option.getOrUndefined(decodeAttachment(socket.deserializeAttachment()));

const kept = (socket: WebSocket, attachment: Attachment) => {
  try {
    socket.serializeAttachment(attachment);

    return true;
  } catch {
    return false;
  }
};

const updated = (
  socket: WebSocket,
  change: (held: Attachment) => Attachment
) => {
  const held = attachmentOf(socket);

  return held !== undefined && kept(socket, change(held));
};

const without = <A>(
  items: readonly A[],
  drop: (item: A) => boolean
): readonly A[] => items.filter((item) => !drop(item));

const park = (socket: WebSocket, entry: Parked) =>
  updated(socket, (held) => ({
    ...held,
    calls: without(held.calls, (call) => call === entry.id),
    parked: [...held.parked, entry],
  }));

const forget = (socket: WebSocket, watch: string) =>
  updated(socket, (held) => ({
    ...held,
    answered: without(held.answered, (answer) => answer.watch === watch),
  }));

const Request = Schema.TaggedStruct("Request", {
  id: RequestId,
  tag: Schema.String,
  payload: Schema.Json,
  headers: Headers,
});

type Request = typeof Request.Type;

const FromClient = Schema.Union([
  Request,
  Schema.TaggedStruct("Interrupt", { requestId: RequestId }),
  Schema.Struct({ _tag: Schema.Literals(["Ack", "Ping", "Eof"]) }),
]);

const decodeFrames = Schema.decodeUnknownEffect(Schema.Array(FromClient));

const decodePoll = Schema.decodeUnknownOption(ActionRpc.Poll);

const decodePage = Schema.decodeUnknownOption(ActionRpc.Page);

export interface Refusal {
  readonly version: string;
  readonly code: number;
  readonly reason: string;
}

export interface Served {
  readonly rpcs: ReadonlyMap<string, Rpc.AnyWithProps>;
  readonly polls: ReadonlySet<string>;
  readonly refusal: Refusal | undefined;
  readonly call: (
    tag: string,
    payload: Schema.Json,
    headers: Headers
  ) => Effect.Effect<Exit.Exit<Schema.Json, unknown>>;
}

const merged = (upgrade: Headers, own: Headers): Headers => {
  const named = new Set(own.map(([name]) => name.toLowerCase()));

  return [
    ...upgrade.filter(([name]) => !named.has(name.toLowerCase())),
    ...own,
  ];
};

const fingerprintOf = (tag: string, payload: Schema.Json, headers: Headers) =>
  Effect.promise(async () => {
    const input = Predicate.isObject(payload)
      ? Object.entries<unknown>(payload).filter(([key]) => key !== "cursor")
      : payload;

    const bytes = new TextEncoder().encode(
      JSON.stringify([tag, input, headers])
    );

    const hash = await crypto.subtle.digest("SHA-256", bytes);

    return new Uint8Array(hash).toHex();
  });

const encodeExit = (rpc: Rpc.AnyWithProps, exit: Exit.Exit<unknown, unknown>) =>
  Schema.encodeUnknownEffect(
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    RpcSerialization.json.codecFor(Rpc.exitSchema(rpc)) as Schema.Codec<
      Exit.Exit<unknown, unknown>,
      unknown
    >
  )(exit);

const unknownTag = (tag: string) => `Unknown request tag: ${tag}`;

const reply = (
  socket: WebSocket,
  served: Served,
  { id, tag }: Pick<Parked, "id" | "tag">,
  exit: Exit.Exit<Schema.Json, unknown>
) =>
  Effect.gen(function* () {
    updated(socket, (held) => ({
      ...held,
      calls: without(held.calls, (call) => call === id),
    }));

    const rpc = served.rpcs.get(tag);

    if (rpc === undefined) {
      send(socket, died(id, unknownTag(tag)));

      return;
    }

    const encoded = yield* Effect.exit(encodeExit(rpc, exit));

    send(
      socket,
      Exit.isSuccess(encoded)
        ? {
            _tag: "Exit",
            requestId: id,
            // oxlint-disable-next-line typescript/no-unsafe-type-assertion
            exit: encoded.value as never,
          }
        : died(id, encoded.cause)
    );
  });

const untracked =
  "This socket's attachment, its upgrade's headers, its calls under way and its parked polls, would pass the runtime's 16 KiB: send fewer calls at once, or fewer or smaller headers";

const lostCalls =
  "This server lost the calls it was answering on this socket: connect again";

const lostSocket =
  "This server cannot read what it kept for this socket: connect again";

/** Together with `ActionRpc.pollResentAfter`, bounds how long an active watch can go without calling the entity. */
export const uncalledWithin = Duration.seconds(30);

const outdated = (socket: WebSocket, served: Served, held: Attachment) => {
  const { refusal } = served;

  if (refusal === undefined || held.version === refusal.version) {
    return false;
  }

  closeQuietly(socket, refusal.code, refusal.reason);

  return true;
};

export const makeSockets = (options: {
  readonly servedBy: (name: string) => Served | undefined;
  readonly gate: () => number | undefined;
  readonly now: () => number;
  readonly sockets: () => readonly WebSocket[];
  readonly waitUntil: (promise: Promise<unknown>) => void;
}) => {
  const { now } = options;

  const signal = Effect.exit(Effect.sync(options.gate));

  let passing = false;
  let again = false;

  const running = new WeakMap<
    WebSocket,
    Map<RequestId, Fiber.Fiber<unknown>>
  >();

  const tracked = <A>(
    socket: WebSocket,
    id: RequestId,
    call: Effect.Effect<A>
  ) =>
    Effect.gen(function* () {
      const calls =
        running.get(socket) ?? new Map<RequestId, Fiber.Fiber<unknown>>();

      running.set(socket, calls);

      const fiber = yield* Effect.forkChild(call);

      calls.set(id, fiber);

      return yield* Effect.onExit(Fiber.await(fiber), (awaited) =>
        Effect.sync(() => {
          calls.delete(id);

          if (Exit.isFailure(awaited) || Exit.hasInterrupts(awaited.value)) {
            updated(socket, (held) => ({
              ...held,
              calls: without(held.calls, (under) => under === id),
            }));
          }
        })
      );
    });

  const due = (moved: (entry: Parked) => boolean) =>
    options.sockets().flatMap((socket) => {
      const held = attachmentOf(socket);

      const served =
        held === undefined ? undefined : options.servedBy(held.name);

      if (
        held === undefined ||
        served === undefined ||
        outdated(socket, served, held)
      ) {
        return [];
      }

      const asking = (entry: Parked) =>
        moved(entry) || !served.rpcs.has(entry.tag);

      const asked = held.parked.filter(asking);

      if (
        asked.length === 0 ||
        !kept(socket, {
          ...held,
          parked: without(held.parked, asking),
          calls: [...held.calls, ...asked.map(({ id }) => id)],
        })
      ) {
        return [];
      }

      return asked.map((entry) => ({ socket, served, entry }));
    });

  const polled = (
    socket: WebSocket,
    served: Served,
    entry: Omit<Parked, "gate">
  ): Effect.Effect<boolean> =>
    Effect.gen(function* () {
      const read = yield* signal;

      if (Exit.isFailure(read)) {
        yield* reply(socket, served, entry, Exit.failCause(read.cause));

        return false;
      }

      const before = read.value;
      const at = now();
      const upgrade = attachmentOf(socket)?.headers ?? [];
      const headers = merged(upgrade, entry.headers);

      const exit = yield* served.call(entry.tag, entry.payload, headers);

      const poll = Option.getOrUndefined(decodePoll(entry.payload));

      const page = Exit.isSuccess(exit)
        ? Option.getOrUndefined(decodePage(exit.value))
        : undefined;

      const holding =
        before !== undefined &&
        page !== undefined &&
        page.notified &&
        !page.hasMore;

      if (
        holding &&
        poll !== undefined &&
        page.events.length === 0 &&
        page.cursor === poll.cursor &&
        park(socket, { ...entry, gate: before })
      ) {
        return true;
      }

      if (holding && poll?.watch !== undefined && page.cursor !== null) {
        const { watch } = poll;
        const { cursor } = page;

        const fingerprint = yield* fingerprintOf(
          entry.tag,
          entry.payload,
          headers
        );

        updated(socket, (held) => ({
          ...held,
          answered: [
            ...without(
              held.answered,
              (answer) =>
                answer.watch === watch ||
                at - answer.at >= Duration.toMillis(uncalledWithin)
            ),
            { watch, cursor, fingerprint, gate: before, at },
          ],
        }));
      }

      yield* reply(socket, served, entry, exit);

      return false;
    });

  const pass = Effect.gen(function* () {
    if (options.sockets().length === 0) {
      return;
    }

    const read = yield* signal;

    if (Exit.isSuccess(read) && read.value === undefined) {
      return;
    }

    const exits = yield* Effect.forEach(
      due((entry) => Exit.isFailure(read) || entry.gate !== read.value),
      ({ socket, served, entry }) =>
        served.rpcs.has(entry.tag)
          ? tracked(socket, entry.id, polled(socket, served, entry))
          : Effect.exit(
              Effect.as(reply(socket, served, entry, Exit.succeed(null)), false)
            ),
      { concurrency: "unbounded" }
    );

    again ||= exits.some((exit) => Exit.isSuccess(exit) && exit.value);
  });

  const passes = async () => {
    try {
      do {
        again = false;
        await Effect.runPromise(pass);
      } while (again);
    } finally {
      passing = false;
    }
  };

  const settled = () => {
    if (passing) {
      again = true;

      return;
    }

    passing = true;
    options.waitUntil(passes());
  };

  const parkedAgain = (socket: WebSocket, request: Request) =>
    Effect.gen(function* () {
      const poll = Option.getOrUndefined(decodePoll(request.payload));

      if (poll?.watch === undefined) {
        return false;
      }

      const held = attachmentOf(socket);
      const answer = held?.answered.find(({ watch }) => watch === poll.watch);

      forget(socket, poll.watch);

      if (
        answer?.fingerprint === undefined ||
        answer.cursor !== poll.cursor ||
        now() - answer.at >= Duration.toMillis(uncalledWithin)
      ) {
        return false;
      }

      const fingerprint = yield* fingerprintOf(
        request.tag,
        request.payload,
        merged(held?.headers ?? [], request.headers)
      );

      if (answer.fingerprint !== fingerprint) {
        return false;
      }

      const read = yield* signal;

      return (
        Exit.isSuccess(read) &&
        read.value === answer.gate &&
        park(socket, {
          id: request.id,
          tag: request.tag,
          payload: request.payload,
          headers: request.headers,
          gate: answer.gate,
        })
      );
    });

  const requested = (socket: WebSocket, served: Served, request: Request) =>
    Effect.gen(function* () {
      const { id, tag, payload, headers } = request;
      const rpc = served.rpcs.get(tag);

      if (rpc === undefined) {
        send(socket, died(id, unknownTag(tag)));

        return;
      }

      if (
        !updated(socket, (held) => ({ ...held, calls: [...held.calls, id] }))
      ) {
        send(socket, died(id, untracked));

        return;
      }

      const upgrade = attachmentOf(socket)?.headers ?? [];

      yield* tracked(
        socket,
        id,
        served.polls.has(tag)
          ? Effect.flatMap(parkedAgain(socket, request), (parked) =>
              parked
                ? Effect.void
                : Effect.asVoid(polled(socket, served, request))
            )
          : Effect.flatMap(
              served.call(tag, payload, merged(upgrade, headers)),
              (exit) => reply(socket, served, request, exit)
            )
      );
    });

  const message = (socket: WebSocket, data: string | ArrayBuffer) =>
    Effect.gen(function* () {
      const held = attachmentOf(socket);

      const served =
        held === undefined ? undefined : options.servedBy(held.name);

      if (held === undefined || served === undefined) {
        closeQuietly(socket, 1012, lostSocket);

        return;
      }

      if (outdated(socket, served, held)) {
        return;
      }

      const frames = yield* Effect.exit(
        Effect.flatMap(
          Effect.try(() =>
            parser.decode(
              Predicate.isString(data) ? data : new Uint8Array(data)
            )
          ),
          (decoded) => decodeFrames(decoded)
        )
      );

      if (Exit.isFailure(frames)) {
        send(
          socket,
          RpcMessage.ResponseDefectEncoded(
            encodeDefect(Cause.squash(frames.cause))
          )
        );

        return;
      }

      yield* Effect.forEach(
        frames.value,
        (frame) => {
          if (frame._tag === "Request") {
            return requested(socket, served, frame);
          }

          if (frame._tag === "Interrupt") {
            updated(socket, (attached) => ({
              ...attached,
              parked: without(
                attached.parked,
                ({ id }) => id === frame.requestId
              ),
            }));

            const call = running.get(socket)?.get(frame.requestId);

            return call === undefined ? Effect.void : Fiber.interrupt(call);
          }

          return Effect.void;
        },
        { concurrency: "unbounded", discard: true }
      );
    }).pipe(Effect.ensuring(Effect.sync(settled)));

  return {
    message,
    settled,
    closed: (socket: WebSocket) =>
      Effect.forEach(
        [...(running.get(socket)?.values() ?? [])],
        Fiber.interrupt,
        {
          concurrency: "unbounded",
          discard: true,
        }
      ),
    accept: (
      socket: WebSocket,
      name: string,
      version: string | null,
      headers: Headers
    ) =>
      kept(
        socket,
        Attachment.make({
          name,
          version,
          headers,
          calls: [],
          parked: [],
          answered: [],
        })
      ),
    started: () => {
      for (const socket of options.sockets()) {
        if ((attachmentOf(socket)?.calls.length ?? 0) > 0) {
          closeQuietly(socket, 1012, lostCalls);
        }
      }

      settled();
    },
  };
};
