import * as CloudflareDurableObjects from "@effect/platform-cloudflare/CloudflareDurableObjects";
import * as Action from "@gjermundgaraba/effect-actions/Action";
import * as ActionEntity from "@gjermundgaraba/effect-actions/ActionEntity";
import * as ActionHttp from "@gjermundgaraba/effect-actions/ActionHttp";
import * as ActionRpc from "@gjermundgaraba/effect-actions/ActionRpc";
import * as Authentication from "@gjermundgaraba/effect-actions/Authentication";
import * as Event from "@gjermundgaraba/effect-actions/Event";
import * as RequestPolicy from "@gjermundgaraba/effect-actions/RequestPolicy";
import * as Stored from "@gjermundgaraba/effect-actions/Stored";
import * as Webhook from "@gjermundgaraba/effect-actions/Webhook";
import {
  Context,
  Deferred,
  Effect,
  Layer,
  Logger,
  Predicate,
  Redacted,
  Schedule,
  Schema,
} from "effect";
import type { Entity } from "effect/cluster";
import { ClusterSchema } from "effect/cluster";
import {
  FetchHttpClient,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/http";
import { KeyValueStore } from "effect/persistence";
import { Rpc, RpcClient, RpcGroup } from "effect/rpc";
import { SqlClient } from "effect/sql";

import * as ActionCluster from "../src/cluster/ActionCluster.js";
import * as ActionWorker from "../src/host/ActionWorker.js";
import {
  Board,
  BoardHttp,
  boardImplementations,
  boardTells,
  Pin,
  Pinned,
  Tally,
  Watcher,
} from "./board.js";

class Caller extends Context.Service<Caller, string>()("tests/Caller") {}

const Login = Authentication.make("tests.Login", Caller, {
  principal: (caller) => caller,
});

const Whoami = Action.make("whoami", {
  description: "Answer the authorization header the entity received.",
  input: { room: Schema.String },
  success: Schema.String,
  progress: { step: Schema.Int },
  readOnly: true,
  caller: Caller,
});

export const Seen = Event.make("seen", {
  description: "Who the entity authenticated a whoami's caller as.",
  input: { room: Schema.String },
  payload: { by: Schema.String },
  caller: Caller,
});

const Read = { headers: Schema.Record(Schema.String, Schema.String) };

const ReadHeaders = Action.make("readHeaders", {
  description: "Answer the headers the entity authenticated the call from.",
  input: { room: Schema.String },
  success: Read,
  readOnly: true,
  caller: Caller,
});

export const StreamHeaders = Action.make("streamHeaders", {
  description: "Answer them after a progress step, as a stream rpc.",
  input: { room: Schema.String },
  success: Read,
  progress: { step: Schema.Int },
  readOnly: true,
  caller: Caller,
});

const Relay = Action.make("relay", {
  description:
    "Send readHeaders to the entity `to` with the caller's authorization, in a forked fiber when it is this entity, whose call waits for this one to end.",
  input: { room: Schema.String, to: Schema.String },
  success: { reached: Schema.NullOr(Schema.String) },
  readOnly: true,
  caller: Caller,
});

const Crash = Action.make("crash", {
  description:
    "Count a run in the entity's activation and record it, then die after the work.",
  input: { room: Schema.String },
  success: Schema.Null,
  readOnly: false,
  caller: Caller,
});

const Linger = Action.make("linger", {
  description:
    "Record its start, then its end 2 seconds later, or its interruption.",
  input: { room: Schema.String },
  success: Schema.Null,
  readOnly: true,
  caller: Caller,
});

const contracts = [
  Linger,
  Whoami,
  Seen,
  ReadHeaders,
  StreamHeaders,
  Relay,
  Crash,
] as const;

export const SeerHttp = ActionHttp.make(contracts, { authentication: Login });

export const SeerTasks = RpcGroup.make(
  Rpc.make("bump", { success: Schema.Int }),
  Rpc.make("hold"),
  Rpc.make("note", { payload: { text: Schema.String } }).annotate(
    ClusterSchema.Persisted,
    true
  ),
  Rpc.make("mark", {
    payload: { id: Schema.String, uninterruptible: Schema.Boolean },
  }),
  Rpc.make("state", {
    success: Schema.Struct({
      name: Schema.NullOr(Schema.String),
      built: Schema.Boolean,
    }),
  }),
  Rpc.make("parked").annotate(ClusterSchema.Persisted, true),
  Rpc.make("transactions", {
    success: Schema.Struct({
      notes: Schema.Array(Schema.String),
      rejectedAsThrown: Schema.Boolean,
    }),
  })
);

const byRoom = ({ room }: { readonly room: string }) => room;

export const Seer = ActionEntity.make(
  "Seer",
  ActionRpc.make(contracts, { authentication: Login }),
  {
    key: byRoom,
    rpcs: SeerTasks,
  }
);

const received: Array<{
  readonly tag: string;
  readonly authorization: string | null;
}> = [];

const headersRead = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;

  received.push({
    tag: "read",
    authorization: request.headers["authorization"] ?? null,
  });

  yield* Effect.log("read", request.headers);

  return { headers: { ...request.headers } };
});

const seeing = [
  Action.implement(
    Linger,
    () =>
      Effect.gen(function* () {
        received.push({ tag: "linger-started", authorization: null });
        yield* Effect.sleep("2 seconds");
        received.push({ tag: "linger-ended", authorization: null });

        return null;
      }).pipe(
        Effect.onInterrupt(() =>
          Effect.sync(() => {
            received.push({ tag: "linger-interrupted", authorization: null });
          })
        )
      ),
    { authorize: Action.allowAll }
  ),
  Action.implement(
    Whoami,
    Effect.map(
      Event.Events,
      (events) =>
        ({ room }, { progress }) =>
          Effect.gen(function* () {
            yield* progress({ step: 1 });

            const request = yield* HttpServerRequest.HttpServerRequest;

            yield* Effect.log("entity", request.headers);

            yield* events.publish(
              Seen,
              { data: { by: yield* Caller } },
              { key: room }
            );

            return request.headers["authorization"] ?? "none";
          })
    ),
    { authorize: Action.allowAll }
  ),
  Event.implement(
    Seen,
    { log: {}, key: ({ room }) => room },
    { authorize: Event.allowAll }
  ),
  Action.implement(ReadHeaders, () => headersRead, {
    authorize: Action.allowAll,
  }),
  Action.implement(
    StreamHeaders,
    (_, { progress }) => Effect.andThen(progress({ step: 1 }), headersRead),
    { authorize: Action.allowAll }
  ),
  Action.implement(
    Relay,
    Effect.map(
      ActionEntity.client(Seer),
      (seers) =>
        ({ room, to }) =>
          Effect.gen(function* () {
            const request = yield* HttpServerRequest.HttpServerRequest;

            const read = seers.readHeaders({ room: to }).pipe(
              RpcClient.withHeaders({
                authorization: request.headers["authorization"] ?? "",
              }),
              Effect.orDie
            );

            const reached =
              to === room
                ? yield* Effect.as(Effect.forkDetach(read), null)
                : yield* Effect.map(
                    read,
                    ({ headers }) => headers["authorization"] ?? null
                  );

            yield* Effect.log("relay", request.headers);

            return { reached };
          })
    ),
    { authorize: Action.allowAll }
  ),
];

const alice = (token: Redacted.Redacted) =>
  Redacted.value(token) === "alice"
    ? Effect.succeed("alice")
    : Effect.fail(new Action.Unauthenticated({ message: "Unknown token." }));

const signIn = Authentication.layer(Login, alice);

const Unkept = Authentication.make("tests.Unkept", Caller, {
  principal: (caller) => caller,
});

export const Kept = Event.make("kept", {
  description: "Nothing, under an authentication with no schema.",
  input: { room: Schema.String },
  payload: { by: Schema.String },
  caller: Caller,
});

export const Keeper = ActionEntity.make(
  "Keeper",
  ActionRpc.make([Kept], { authentication: Unkept }),
  { key: byRoom }
);

const keeping = ActionEntity.layer(
  Keeper,
  Event.implement(
    Kept,
    {
      notified: true,
      check: () => Effect.succeed({ cursor: "0", events: [] }),
    },
    { authorize: Event.allowAll }
  ),
  {
    services: Webhook.layer({ persist: true, resolveCallbacks: false }).pipe(
      Layer.provide([KeyValueStore.layerMemory, FetchHttpClient.layer])
    ),
  }
).pipe(Layer.provide([Authentication.layer(Unkept, alice), Event.layerMemory]));

const entitySql = Layer.effect(SqlClient.SqlClient)(ActionCluster.Sql.orDie);

class Bumps extends Context.Service<Bumps, { count: number }>()(
  "tests/Bumps"
) {}

const crashing = Action.implement(
  Crash,
  Effect.map(
    Bumps,
    (bumps) => () =>
      Effect.andThen(
        Effect.sync(() => {
          bumps.count += 1;
          received.push({ tag: "crash", authorization: null });
        }),
        Effect.die(new Error("planted after the work"))
      )
  ),
  { authorize: Action.allowAll }
);

const parking = Deferred.makeUnsafe<true>();

const seerTasks = Effect.map(
  Effect.all([Bumps, ActionCluster.ObjectState.orDie]),
  ([bumps, built]) =>
    ({
      state: () =>
        Effect.map(ActionCluster.ObjectState.orDie, (state) => {
          state.waitUntil(
            (async () => {
              await scheduler.wait(300);
              received.push({ tag: "waited", authorization: null });
            })()
          );

          return {
            name: state.id.name ?? null,
            built: state === built && state.storage === built.storage,
          };
        }),
      bump: () => Effect.sync(() => (bumps.count += 1)),
      parked: () =>
        Rpc.fork(
          Effect.andThen(
            Effect.sync(() => {
              received.push({ tag: "parked", authorization: null });
            }),
            Effect.asVoid(Deferred.await(parking))
          )
        ),
      transactions: () =>
        Effect.gen(function* () {
          const { storage, database } = yield* ActionCluster.ObjectState.orDie;
          const planted = new Error("planted rollback");

          const note = (text: string) => {
            database.sql.exec("INSERT INTO seer_notes (note) VALUES (?)", text);
          };

          storage.sql.exec(
            "CREATE TABLE IF NOT EXISTS seer_notes (note TEXT NOT NULL)"
          );

          return yield* Effect.promise(async () => {
            await database.transaction(async () => {
              note("kept");
            });

            const rejectedAsThrown = await database
              .transaction(async () => {
                note("rolled back");
                Deferred.doneUnsafe(parking, Effect.succeed(true));

                throw planted;
              })
              .then(
                () => false,
                (error: unknown) => error === planted
              );

            const notes = storage.sql
              .exec<{ note: string }>(
                "SELECT note FROM seer_notes ORDER BY rowid"
              )
              .toArray()
              .map((row) => row.note);

            return { notes, rejectedAsThrown };
          });
        }),
      hold: () =>
        Rpc.fork(
          Effect.andThen(
            Effect.sync(() => {
              received.push({ tag: "holding", authorization: null });
            }),
            Effect.sleep("3 seconds")
          )
        ),
      mark: ({ payload: { id, uninterruptible } }) => {
        const work = Effect.gen(function* () {
          received.push({ tag: `marking-${id}`, authorization: null });
          yield* Effect.sleep("400 millis");
          received.push({ tag: `mark-${id}`, authorization: null });
        });

        return uninterruptible ? Rpc.uninterruptible(work) : work;
      },
      note: ({ headers }) =>
        Effect.sync(() => {
          received.push({
            tag: "note",
            authorization: headers["authorization"] ?? null,
          });
        }),
    }) satisfies Entity.HandlersFrom<RpcGroup.Rpcs<typeof SeerTasks>>
);

const logged: string[] = [];

const recording = Logger.layer([
  Logger.make(({ message }) => {
    logged.push(JSON.stringify(message));
  }),
]);

const edgeLog = HttpRouter.middleware(
  (httpEffect) =>
    Effect.tap(httpEffect, () =>
      Effect.flatMap(
        Effect.service(HttpServerRequest.HttpServerRequest),
        ({ headers }) => Effect.log("edge", headers)
      )
    ),
  { global: true }
);

const stall = {
  above: false,
  released: false,
  builds: 0,
  finished: 0,
  disposed: 0,
};

const untilReleased = Effect.sleep("50 millis").pipe(
  Effect.repeat({
    until: () => stall.released,
    schedule: Schedule.spaced("50 millis"),
  })
);

const stallingAboveTheCluster = Layer.effectDiscard(
  Effect.gen(function* () {
    stall.builds += 1;

    const build = stall.builds;

    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        stall.disposed += 1;
      })
    );

    if (stall.above && build === 1) {
      yield* untilReleased;
    }

    stall.finished += 1;
  })
);

const signedIn = <A, E, R>(layer: Layer.Layer<A, E, R>) =>
  layer.pipe(Layer.provide([signIn, recording]));

const boardSocket = (type: string) => ({
  path: `/sockets/${type}/:id`,
  id: (sent: string) => (sent === "refused" ? undefined : sent),
});

const versioned = { version: "1", code: 4000 };

const worker = ActionWorker.make<Cloudflare.Env>({
  entities: [
    {
      entity: Seer,
      layer: () =>
        signedIn(
          ActionEntity.layer(Seer, [...seeing, crashing], {
            services: Layer.merge(
              Stored.layerIdempotency.pipe(
                Layer.provideMerge(ActionCluster.layerObject)
              ),
              Layer.sync(Bumps)(() => ({ count: 0 }))
            ),
            rpcs: seerTasks,
          })
        ),
      socket: { ...boardSocket("Seer"), protocol: versioned },
    },
    {
      entity: Board,
      layer: () =>
        ActionEntity.layer(Board, boardImplementations, {
          services: ActionCluster.layerObject,
          rpcs: boardTells,
        }),
      socket: { ...boardSocket("Board"), protocol: versioned },
    },
    {
      entity: Tally,
      layer: () =>
        ActionEntity.layer(Tally, boardImplementations, {
          services: Layer.merge(Event.layerMemory, entitySql),
        }),
      socket: { ...boardSocket("Tally"), protocol: versioned },
    },
    {
      entity: Watcher,
      layer: () =>
        ActionEntity.layer(Watcher, boardImplementations, {
          services: ActionCluster.layerObject,
        }),
      socket: { ...boardSocket("Watcher"), actions: [Pin, Pinned] },
    },
    { entity: Keeper, layer: () => keeping },
  ],
  routes: () =>
    Layer.mergeAll(
      ActionHttp.layer(SeerHttp, ActionEntity.reaching(Seer)),
      ActionHttp.layer(BoardHttp, ActionEntity.reaching(Board)),
      HttpRouter.add(
        "GET",
        "/gone",
        HttpServerResponse.text("gone", { status: 404 })
      ),
      edgeLog,
      stallingAboveTheCluster
    ).pipe(Layer.provide(signIn), Layer.provideMerge(recording)),
  policy: () =>
    RequestPolicy.make({ publicUrl: new URL("https://worker.example") }),
  fallback: (request) =>
    new Response(`page ${new URL(request.url).pathname}`, {
      headers: { "x-fallback": "page" },
    }),
});

export const initialize = worker.context;

export const { ClusterDurableQueue, ClusterSingleton, ClusterWorkflow } =
  worker;

const started = { invoke: 0, hold: 0, acknowledge: 0 };

const finished = { invoke: 0, hold: 0, acknowledge: 0 };

const instances: string[] = [];

const counted = async <A>(
  method: keyof typeof started,
  call: () => Promise<A>
): Promise<A> => {
  started[method] += 1;

  return await call().finally(() => {
    finished[method] += 1;
  });
};

export class ClusterEntity extends worker.ClusterEntity {
  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    instances.push(`${ctx.id.name ?? ""}#${crypto.randomUUID()}`);
  }
}

const countedMethods = ["invoke", "hold", "acknowledge"] as const;

for (const method of countedMethods) {
  const original: unknown = Object.getOwnPropertyDescriptor(
    CloudflareDurableObjects.ClusterEntity.prototype,
    method
  )?.value;

  if (!Predicate.isFunction(original)) {
    throw new TypeError(`ClusterEntity has no ${method} to count`);
  }

  Object.defineProperty(ClusterEntity.prototype, method, {
    async value(this: unknown, ...args: unknown[]): Promise<unknown> {
      return await counted(
        method,
        async (): Promise<unknown> => await original.apply(this, args)
      );
    },
  });
}

export const foreignOrigin = "https://elsewhere.example";

export default {
  async fetch(request: Request, env: Cloudflare.Env) {
    const { pathname } = new URL(request.url);

    if (pathname === "/stubs") {
      return Response.json({ started, finished, instances });
    }

    if (pathname === "/logged") {
      return Response.json(logged.splice(0));
    }

    if (pathname === "/received") {
      return Response.json(received.splice(0));
    }

    if (pathname === "/stall-above") {
      stall.above = true;
    }

    if (pathname === "/release") {
      stall.released = true;
    }

    if (["/stall-above", "/release"].includes(pathname)) {
      return Response.json({
        builds: stall.builds,
        finished: stall.finished,
        disposed: stall.disposed,
      });
    }

    return await worker.fetch(request, env);
  },
} satisfies ExportedHandler<Cloudflare.Env>;
