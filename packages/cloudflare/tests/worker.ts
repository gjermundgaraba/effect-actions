import * as CloudflareCluster from "@effect/platform-cloudflare/CloudflareCluster";
import * as CloudflareDurableObjects from "@effect/platform-cloudflare/CloudflareDurableObjects";
import * as Action from "@gjermundgaraba/effect-actions/Action";
import * as ActionEntity from "@gjermundgaraba/effect-actions/ActionEntity";
import * as ActionHttp from "@gjermundgaraba/effect-actions/ActionHttp";
import * as ActionRpc from "@gjermundgaraba/effect-actions/ActionRpc";
import * as Authentication from "@gjermundgaraba/effect-actions/Authentication";
import * as Event from "@gjermundgaraba/effect-actions/Event";
import * as Stored from "@gjermundgaraba/effect-actions/Stored";
import * as Webhook from "@gjermundgaraba/effect-actions/Webhook";
import {
  Context,
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
  HttpServer,
  HttpServerRequest,
} from "effect/http";
import { KeyValueStore } from "effect/persistence";
import { Rpc, RpcClient, RpcGroup } from "effect/rpc";
import { SqlClient } from "effect/sql";

import * as ActionCluster from "../src/cluster/ActionCluster.js";
import * as ActionClusterEntity from "../src/host/ActionClusterEntity.js";
import {
  Board,
  BoardHttp,
  boardImplementations,
  boardTells,
  Tally,
  Unbound,
} from "./board.js";

export {
  ClusterDurableQueue,
  ClusterSingleton,
  ClusterWorkflow,
} from "@effect/platform-cloudflare/CloudflareDurableObjects";

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

const StreamHeaders = Action.make("streamHeaders", {
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

const entitySql = Layer.effect(SqlClient.SqlClient)(
  CloudflareCluster.DurableObjectSqlClient.orDie
);

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
  requested: false,
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

const stallingTheFirstBuild = Effect.suspend(() => {
  stall.builds += 1;

  return stall.requested && !stall.above && stall.builds === 1
    ? untilReleased.pipe(
        Effect.andThen(Effect.die(new Error("planted: the stalled build")))
      )
    : Effect.void;
});

const stallingAboveTheCluster = (build: number) =>
  Layer.effectDiscard(
    Effect.gen(function* () {
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

const served = (env: Cloudflare.Env) =>
  Layer.mergeAll(
    ActionEntity.layer(Seer, [...seeing, crashing], {
      services: Layer.merge(
        Layer.merge(Stored.layerEvents, Stored.layerIdempotency).pipe(
          Layer.provide(entitySql)
        ),
        Layer.sync(Bumps)(() => ({ count: 0 }))
      ),
      rpcs: seerTasks,
    }),
    ActionEntity.layer(Board, boardImplementations, {
      services: Stored.layerEvents.pipe(Layer.provideMerge(entitySql)),
      rpcs: boardTells,
    }),
    ActionEntity.layer(Tally, boardImplementations, {
      services: Layer.merge(Event.layerMemory, entitySql),
    }),
    keeping,
    Layer.mergeAll(
      ActionHttp.layer(SeerHttp, ActionEntity.reaching(Seer)),
      ActionHttp.layer(BoardHttp, ActionEntity.reaching(Board)),
      edgeLog
    ).pipe(Layer.provide(HttpServer.layerServices))
  ).pipe(
    Layer.provide(signIn),
    Layer.provideMerge(
      ActionCluster.layer({
        entities: [Seer, Board, Tally, Keeper],
        entityNamespace: env.CLUSTER_ENTITY,
        workflowNamespace: env.CLUSTER_WORKFLOW,
        queueNamespace: env.CLUSTER_QUEUE,
        singletonNamespace: env.CLUSTER_SINGLETON,
      })
    ),
    Layer.provideMerge(recording)
  );

const application = (env: Cloudflare.Env) =>
  Layer.unwrap(
    Effect.map(stallingTheFirstBuild, () =>
      stallingAboveTheCluster(stall.builds).pipe(
        Layer.provideMerge(served(env))
      )
    )
  );

export const initialize = CloudflareDurableObjects.setInitializer(
  ActionCluster.initializer(application)
);

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

const Host = ActionClusterEntity.make({
  initialize,
  sockets: [Seer, Board, Tally],
  protocol: { version: "1", code: 4000 },
});

export class OpenHost extends ActionClusterEntity.make({
  initialize,
  sockets: [Board, Unbound],
}) {}

export class ClusterEntity extends Host {
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

const handled = ActionCluster.handler(initialize, {
  sockets: {
    entityNamespace: (env) => env.CLUSTER_ENTITY,
    routes: [Seer, Board, Tally].map((entity) => ({
      entity,
      path: `/sockets/${entity.type}/:id`,
      id: (sent: string, request: Request) =>
        request.headers.get("origin") === foreignOrigin ? undefined : sent,
    })),
  },
});

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

    if (pathname === "/stall" || pathname === "/release") {
      stall.requested = true;
      stall.released = pathname === "/release";
    }

    if (["/stall", "/stall-above", "/release"].includes(pathname)) {
      return Response.json({
        builds: stall.builds,
        finished: stall.finished,
        disposed: stall.disposed,
      });
    }

    return await handled.fetch(request, env);
  },
} satisfies ExportedHandler<Cloudflare.Env>;
