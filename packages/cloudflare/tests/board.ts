import * as Action from "@gjermundgaraba/effect-actions/Action";
import * as ActionEntity from "@gjermundgaraba/effect-actions/ActionEntity";
import * as ActionHttp from "@gjermundgaraba/effect-actions/ActionHttp";
import * as ActionRpc from "@gjermundgaraba/effect-actions/ActionRpc";
import * as Event from "@gjermundgaraba/effect-actions/Event";
import {
  DateTime,
  Duration,
  Effect,
  PrimaryKey,
  Queue,
  Schema,
  Stream,
} from "effect";
import { ClusterSchema, DeliverAt, Entity } from "effect/cluster";
import { Rpc, RpcGroup } from "effect/rpc";
import { SqlClient } from "effect/sql";

const onBoard = { board: Schema.String };

export const Note = Schema.Struct({ n: Schema.Int });

export const Pinned = Event.make("board.pinned", {
  description: "A note pinned to the board, read from its table.",
  input: onBoard,
  payload: Note,
  caller: Action.Anyone,
});

export const Logged = Event.make("board.logged", {
  description: "A note pinned to the board, as its log keeps it.",
  input: onBoard,
  payload: Note,
  caller: Action.Anyone,
});

export const Heard = Event.make("board.heard", {
  description:
    "A note heard on the board's wire, appended by its log's emit stream outside any handler.",
  input: onBoard,
  payload: Note,
  caller: Action.Anyone,
});

export const Hooked = Event.make("board.hooked", {
  description:
    "A note pinned to the board, read from its table by a source holding a subscription hook.",
  input: onBoard,
  payload: Note,
  caller: Action.Anyone,
});

export const Leased = Event.make("board.leased", {
  description:
    "A note pinned to the board, read from its table by a source holding a subscription hook on a 10-second lease.",
  input: onBoard,
  payload: Note,
  caller: Action.Anyone,
});

export const Polled = Event.make("board.polled", {
  description:
    "A note pinned to the board, read from its table by a source that is not notified.",
  input: onBoard,
  payload: Note,
  caller: Action.Anyone,
});

export const Pin = Action.make("pin", {
  description:
    "Pin a note to the board: a row of its table and an entry of its log.",
  input: { ...onBoard, n: Schema.Int },
  success: Schema.Null,
  readOnly: false,
  caller: Action.Anyone,
});

export const Later = Action.make("later", {
  description:
    "Pin a note at a later time, through a persisted tell the board sends itself.",
  input: { ...onBoard, n: Schema.Int, at: Schema.Int },
  success: Schema.Null,
  readOnly: false,
  caller: Action.Anyone,
});

const contracts = [
  Pin,
  Later,
  Pinned,
  Logged,
  Heard,
  Hooked,
  Leased,
  Polled,
] as const;

export const BoardRpc = ActionRpc.make(contracts);

export const BoardHttp = ActionHttp.make(contracts);

export class Delayed extends Schema.Class<
  Delayed,
  { readonly brand: unique symbol }
>("tests/Delayed")({ n: Schema.Int, at: Schema.Int }) {
  [PrimaryKey.symbol]() {
    return String(this.n);
  }

  [DeliverAt.symbol]() {
    return DateTime.makeUnsafe(this.at);
  }
}

export const BoardTells = RpcGroup.make(
  Rpc.make("delayed", { payload: Delayed })
).annotateRpcs(ClusterSchema.Persisted, true);

const key = ({ board }: { readonly board: string }) => board;

export const Board = ActionEntity.make("Board", BoardRpc, {
  key,
  rpcs: BoardTells,
});

export const Tally = ActionEntity.make("Tally", BoardRpc, { key });

export const Unbound = ActionEntity.make("Unbound", BoardRpc, { key });

const Rows = Schema.Array(Schema.Struct({ n: Schema.Int }));

const pinned = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const events = yield* Event.Events;

  yield* Effect.orDie(
    sql`CREATE TABLE IF NOT EXISTS board_notes (n INTEGER NOT NULL)`
  );

  return (n: number) =>
    Effect.gen(function* () {
      yield* sql`INSERT INTO board_notes (n) VALUES (${n})`;
      yield* events.notify(Pinned);
      yield* events.notify(Hooked);
      yield* events.notify(Leased);
      yield* events.publish(Logged, { data: { n } });
    }).pipe(Effect.orDie);
});

const pinning = Action.implement(
  [Pin, Later],
  Effect.gen(function* () {
    const pin = yield* pinned;
    const { entityId } = yield* Entity.CurrentAddress;
    const boards = yield* Board.client;

    return {
      pin: ({ n }) => Effect.as(pin(n), null),
      later: ({ n, at }) =>
        Effect.as(
          Effect.orDie(
            boards(entityId).delayed(new Delayed({ n, at }), { discard: true })
          ),
          null
        ),
    };
  })
);

const Count = Schema.Array(Schema.Struct({ count: Schema.Int }));

const polledTable = Effect.map(SqlClient.SqlClient, (sql) => ({
  check: (_input: unknown, cursor: string | null) =>
    Effect.gen(function* () {
      const [{ count } = { count: 0 }] =
        yield* sql`SELECT count(*) AS count FROM board_notes`.pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(Count))
        );

      const after = cursor === null ? count : Math.min(Number(cursor), count);

      const rows =
        yield* sql`SELECT n FROM board_notes ORDER BY rowid LIMIT -1 OFFSET ${after}`.pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(Rows))
        );

      return {
        cursor: String(count),
        events: rows.map((data) => ({ data })),
        nextPoll: Duration.seconds(1),
      };
    }).pipe(Effect.orDie),
}));

const fromTable = Effect.map(polledTable, (source) => ({
  ...source,
  notified: true,
}));

const pinnedFromTable = Event.implement(Pinned, fromTable);

const polledFromTable = Event.implement(Polled, polledTable);

export const hooks: string[] = [];

const hookedOn = (lease?: Duration.Input) =>
  Effect.map(fromTable, (source) => ({
    ...source,
    subscription: ({ board }: { readonly board: string }) =>
      Effect.acquireRelease(
        Effect.sync(() => hooks.push(`set up ${board}`)),
        () => Effect.sync(() => hooks.push(`torn down ${board}`))
      ),
    lease,
  }));

const hookedFromTable = Event.implement(Hooked, hookedOn());

const leasedFromTable = Event.implement(Leased, hookedOn("10 seconds"));

const fromLog = Event.implement(Logged, { log: {} });

export const wires = new Map<string, Queue.Queue<number>>();

const fromWire = Event.implement(
  Heard,
  Effect.gen(function* () {
    const { entityId } = yield* Entity.CurrentAddress;
    const wire = wires.get(entityId) ?? (yield* Queue.unbounded<number>());

    wires.set(entityId, wire);

    return {
      log: {
        emit: Stream.fromQueue(wire).pipe(Stream.map((n) => ({ data: { n } }))),
      },
    };
  })
);

export const boardImplementations = [
  pinning,
  pinnedFromTable,
  hookedFromTable,
  leasedFromTable,
  polledFromTable,
  fromLog,
  fromWire,
];

export const boardTells = Effect.map(
  pinned,
  (pin) =>
    ({
      delayed: ({ payload: { n } }) => pin(n),
    }) satisfies Entity.HandlersFrom<RpcGroup.Rpcs<typeof BoardTells>>
);
