import { env, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { Cause, Effect, Exit, Layer, Predicate, Schema, Stream } from "effect";
import { Rpc as NativeRpc, RpcClient, RpcClientError, RpcGroup, RpcServer } from "effect/rpc";
import { describe, expect, it } from "@effect/vitest";
import * as Action from "@gjermundgaraba/effect-actions/Action";
import * as ActionRpc from "@gjermundgaraba/effect-actions/ActionRpc";
import * as Event from "@gjermundgaraba/effect-actions/Event";
import * as ActionDurableObject from "../../src/durable/ActionDurableObject.js";
import { makeStubProtocol } from "../../src/durable/calls.js";
import { noteHeader, Overdrawn, Rpc } from "../support/app.js";
import {
  PaneRpcs,
  PluginHasNoPane,
  PluginNotFound,
  PluginRpcs,
  StreamRpcs,
} from "../support/hosts.js";

const plugin = (id: string) => env.PLUGIN_HOST.getByName(id);

const plugins = ActionDurableObject.client(PluginRpcs);

const rawOver = (stub: ActionDurableObject.Stub | (() => ActionDurableObject.Stub)) =>
  RpcClient.make(PluginRpcs).pipe(Effect.provide(ActionDurableObject.layerStubClient(stub)));

const defectOf = <A, E>(exit: Exit.Exit<A, E>) =>
  Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined;

const asAda = RpcClient.withHeaders({ authorization: "Bearer ada" });

const abort = (stub: DurableObjectStub) =>
  Effect.promise(() =>
    runInDurableObject(stub, (_, state) => state.abort("aborted")).catch(String),
  );

describe("layerStubClient", () => {
  it.effect("calls a group's rpcs over the stub, with their successes and declared errors", () =>
    Effect.gen(function* () {
      const client = yield* rawOver(plugin("raw"));

      expect(yield* Effect.flip(client.start())).toEqual(new PluginNotFound({ plugin: "unknown" }));
      expect(yield* client.install({ code: { plugin: "notes", pane: false } })).toEqual({
        version: 1,
      });
      expect(yield* Effect.flip(client.start())).toEqual(new PluginHasNoPane({ plugin: "notes" }));
      expect(yield* client.install({ code: { plugin: "notes", pane: true } })).toEqual({
        version: 2,
      });
      expect(yield* client.start()).toEqual({ pane: "notes/1" });
    }).pipe(Effect.scoped),
  );

  it.effect("answers a call on an evicted object, which builds again", () =>
    Effect.gen(function* () {
      const stub = plugin("evicted");
      const client = yield* rawOver(stub);

      yield* client.install({ code: { plugin: "notes", pane: true } });
      expect(yield* client.start()).toEqual({ pane: "notes/1" });

      yield* Effect.promise(() => evictDurableObject(stub));

      expect(yield* client.start()).toEqual({ pane: "notes/2" });
      expect(yield* client.panes()).toEqual(["notes/1", "notes/2"]);
    }).pipe(Effect.scoped),
  );

  it.effect("answers each of several calls in flight on one stub with its own response", () =>
    Effect.gen(function* () {
      const client = yield* rawOver(plugin("concurrent"));

      const calls = [
        { text: "slow", millis: 40 },
        { text: "now", millis: 0 },
        { text: "soon", millis: 20 },
        { text: "later", millis: 30 },
      ];

      expect(
        yield* Effect.forEach(calls, (call) => client.echo(call), { concurrency: "unbounded" }),
      ).toEqual(calls.map(({ text }) => text));
    }).pipe(Effect.scoped),
  );

  it.effect("calls a function it is given for a new stub as each call is sent", () =>
    Effect.gen(function* () {
      let made = 0;

      const client = yield* rawOver(() => {
        made += 1;

        return plugin("factory");
      });

      yield* client.install({ code: { plugin: "notes", pane: true } });

      expect(made).toBe(1);
      expect(yield* client.start()).toEqual({ pane: "notes/1" });
      expect(made).toBe(2);
    }).pipe(Effect.scoped),
  );

  it.effect(
    "reaches a new stub from its function after an exception broke the one before, the runtime's error the typed failure's cause",
    () =>
      Effect.gen(function* () {
        const broken = plugin("factory-broken");
        const stubs = [broken];
        const client = yield* rawOver(() => stubs.shift() ?? plugin("factory-broken"));

        yield* abort(broken);

        const error = yield* Effect.flip(client.panes());

        expect(error).toBeInstanceOf(RpcClientError.RpcClientError);
        expect(String(error.reason.cause)).toContain("aborted");
        expect(
          Predicate.hasProperty(error.reason.cause, "durableObjectReset") &&
            error.reason.cause.durableObjectReset,
        ).toBe(true);
        expect(yield* client.panes()).toEqual([]);
      }).pipe(Effect.scoped),
  );

  it.effect("fails with RpcClientError when the stub throws", () =>
    Effect.gen(function* () {
      const client = yield* rawOver({
        effectActionsRpc: () => Promise.reject(new Error("The object is gone")),
      });

      const error = yield* Effect.flip(client.panes());

      expect(error).toBeInstanceOf(RpcClientError.RpcClientError);
      expect(error.reason._tag).toBe("RpcClientDefect");
      expect(String(error.reason.cause)).toContain("The object is gone");
    }).pipe(Effect.scoped),
  );

  it.effect("fails with RpcClientError when the answer ends before the call completes", () =>
    Effect.gen(function* () {
      const client = yield* rawOver({ effectActionsRpc: () => Promise.resolve([]) });

      const error = yield* Effect.flip(client.panes());

      expect(error.reason.message).toBe(
        "The object's answer ended before the call completed: delegate effectActionsRpc to handlers' own, returning its answer",
      );
    }).pipe(Effect.scoped),
  );

  it.effect(
    "fails with RpcClientError when the answer's exit is another request's, its id's digits of the other type included, or no response",
    () =>
      Effect.gen(function* () {
        const exitOf = (requestId: string | number) => [
          { _tag: "Exit", requestId, exit: { _tag: "Success", value: [] } },
        ];

        const answers: ReadonlyArray<
          (request: ActionDurableObject.StubRequest) => ReadonlyArray<unknown>
        > = [
          () => exitOf("another request"),
          (request) =>
            request.flatMap((message) =>
              Predicate.isTagged(message, "Request")
                ? exitOf(Predicate.isString(message.id) ? Number(message.id) : String(message.id))
                : [],
            ),
          () => [{ _tag: "Exit" }],
          () => [null],
        ];

        for (const answer of answers) {
          const client = yield* rawOver({
            effectActionsRpc: (request) => Promise.resolve(answer(request)),
          });

          const error = yield* Effect.flip(client.panes());

          expect(error.reason.message, String(answer)).toContain(
            "The object's answer ended before the call completed",
          );
        }
      }).pipe(Effect.scoped),
  );

  it.effect(
    "fails with RpcClientError on an object whose calls run no server on the protocol",
    () =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(
          Effect.flatMap(rawOver(env.UNSERVED.getByName("unserved")), (client) => client.panes()),
        );

        expect(String(error.reason.cause)).toContain(
          "No rpc server runs on this object's stub protocol",
        );
      }).pipe(Effect.scoped),
  );

  it.effect("fails with RpcClientError past the platform's 32 MiB limit on a call", () =>
    Effect.gen(function* () {
      const client = yield* rawOver(plugin("large"));

      const error = yield* Effect.flip(
        client.echo({ text: "x".repeat(33 * 1024 * 1024), millis: 0 }),
      );

      expect(String(error.reason.cause)).toContain("limited to 32MiB");
    }).pipe(Effect.scoped),
  );

  it.effect("fails with RpcClientError on an object serving no calls, at once", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        Effect.flatMap(rawOver(env.ROOM.getByName("no-calls")), (client) => client.panes()),
      );

      expect(error).toBeInstanceOf(RpcClientError.RpcClientError);
      expect(String(error.reason.cause)).toContain("serves no rpcs over its stub");
    }).pipe(Effect.scoped),
  );

  it.effect("serves through a class of its own delegating the method in one line", () =>
    Effect.gen(function* () {
      const client = yield* rawOver(env.DELEGATING.getByName("delegating"));

      yield* client.install({ code: { plugin: "notes", pane: true } });
      expect(yield* client.start()).toEqual({ pane: "notes/1" });
    }).pipe(Effect.scoped),
  );

  it.effect("answers an rpc that streams with a defect naming it, and others as before", () =>
    Effect.gen(function* () {
      const client = yield* RpcClient.make(StreamRpcs).pipe(
        Effect.provide(ActionDurableObject.layerStubClient(env.STREAMED.getByName("streams"))),
      );

      const exit = yield* Effect.exit(Stream.runCollect(client.tail()));

      expect(String(defectOf(exit))).toContain("The rpc tail streams");
      expect(yield* client.head()).toBe("head");
    }).pipe(Effect.scoped),
  );

  it.effect(
    "fails an ActionRpc layer's build serving a streaming or progress action, an event type or a native stream rpc, and builds it serving the others alone",
    () =>
      Effect.gen(function* () {
        const Tail = Action.make("tail", {
          description: "Stream a log's lines.",
          success: Action.Stream(Schema.String),
          readOnly: true,
          caller: Action.Anyone,
        });

        const Build = Action.make("build", {
          description: "Build, reporting each step.",
          success: Schema.String,
          progress: { step: Schema.Int },
          readOnly: false,
          caller: Action.Anyone,
        });

        const Head = Action.make("head", {
          description: "Read a log's first line.",
          success: Schema.String,
          readOnly: true,
          caller: Action.Anyone,
        });

        const Ticked = Event.make("clock.ticked", {
          description: "The clock ticked.",
          payload: { at: Schema.Int },
          caller: Action.Anyone,
        });

        const Logs = ActionRpc.make([Tail, Build, Head, Ticked]);

        const Followed = ActionRpc.make([Head], {
          rpcs: RpcGroup.make(NativeRpc.make("follow", { success: Schema.String, stream: true })),
        });

        const implementations = [
          Action.implement(Tail, () => Stream.make("a")),
          Action.implement(Build, () => Effect.succeed("built")),
          Action.implement(Head, () => Effect.succeed("a")),
          Event.implement(Ticked, {
            check: () => Effect.succeed({ cursor: "0", events: [] }),
          }),
        ];

        const built = <E>(served: Layer.Layer<never, E, RpcServer.Protocol | Event.Events>) =>
          Effect.promise(() =>
            runInDurableObject(env.PLUGIN_HOST.getByName("streams"), (_, state) =>
              Effect.runPromiseExit(
                Layer.build(
                  served.pipe(
                    Layer.provide(Event.layerMemory),
                    Layer.provide(
                      Layer.effect(RpcServer.Protocol)(
                        Effect.map(makeStubProtocol, ({ protocol }) => protocol),
                      ),
                    ),
                    Layer.provide(Layer.succeed(ActionDurableObject.State, state)),
                  ),
                ).pipe(Effect.scoped),
              ).then((exit) => (Exit.isFailure(exit) ? String(defectOf(exit)) : "built")),
            ),
          );

        const following = ActionRpc.layer(Followed, [
          Action.implement(Head, () => Effect.succeed("a")),
        ]).pipe(Layer.provide(Followed.rpcs.toLayer({ follow: () => Stream.make("a") })));

        expect(yield* built(ActionRpc.layer(Logs, implementations))).toContain(
          "ActionRpc.layer serves a protocol answering each call once, and tail, build, clock.ticked stream",
        );
        expect(yield* built(following)).toContain("and follow stream");
        expect(yield* built(ActionRpc.layer(Logs, implementations, { actions: [Head] }))).toBe(
          "built",
        );
      }),
  );

  it.effect("serves an ActionRpc contract, authenticated from each call's headers", () =>
    Effect.gen(function* () {
      const client = yield* ActionRpc.client(Rpc);

      expect(yield* client.whoami().pipe(asAda)).toBe("ada");
      expect(yield* client.spend({ amount: 4 }).pipe(asAda)).toEqual({ left: 6 });
      expect(yield* Effect.flip(client.spend({ amount: 7 }).pipe(asAda))).toEqual(
        new Overdrawn({ by: 1 }),
      );
      expect(
        yield* client.readNote().pipe(RpcClient.withHeaders({ [noteHeader]: "over the stub" })),
      ).toBe("over the stub");
      expect(yield* Effect.flip(client.whoami())).toBeInstanceOf(Action.Unauthenticated);
    }).pipe(
      Effect.scoped,
      Effect.provide(ActionDurableObject.layerStubClient(env.STUBBED.getByName("contract"))),
    ),
  );
});

describe("client", () => {
  it.effect("calls an object through its stub, failing with the declared errors alone", () =>
    Effect.gen(function* () {
      const host = yield* plugins;

      expect(yield* Effect.flip(host(() => plugin("by-key")).start())).toEqual(
        new PluginNotFound({ plugin: "unknown" }),
      );
      yield* host(() => plugin("by-key")).install({ code: { plugin: "notes", pane: true } });
      expect(yield* host(() => plugin("by-key")).start()).toEqual({ pane: "notes/1" });
      expect(yield* host(() => plugin("another")).panes()).toEqual([]);
    }).pipe(Effect.scoped),
  );

  it.effect(
    "answers several calls in flight to several objects with their own responses, through one client",
    () =>
      Effect.gen(function* () {
        const host = yield* plugins;

        const calls = ["a", "b", "c", "a", "b"].map((id, index) => ({
          id,
          text: `${id}${index}`,
          millis: 10 * (5 - index),
        }));

        expect(
          yield* Effect.forEach(calls, ({ id, ...call }) => host(() => plugin(id)).echo(call), {
            concurrency: "unbounded",
          }),
        ).toEqual(calls.map(({ text }) => text));
      }).pipe(Effect.scoped),
  );

  it.effect("gets a stub from its factory for every call", () =>
    Effect.gen(function* () {
      const host = yield* plugins;

      let made = 0;

      const counted = host(() => {
        made += 1;

        return plugin("counted");
      });

      yield* counted.install({ code: { plugin: "notes", pane: true } });
      expect(yield* counted.start()).toEqual({ pane: "notes/1" });
      expect(made).toBe(2);
    }).pipe(Effect.scoped),
  );

  it.effect("answers through a new stub after an exception broke the one before", () =>
    Effect.gen(function* () {
      const host = yield* plugins;
      const broken = plugin("broken");
      const raw = yield* rawOver(broken);

      yield* raw.install({ code: { plugin: "notes", pane: true } });
      yield* abort(broken);

      for (const _ of [1, 2]) {
        expect(String((yield* Effect.flip(raw.panes())).reason.cause)).toContain("aborted");
      }

      const stubs = [broken];
      const recovering = host(() => stubs.shift() ?? plugin("broken"));

      expect(String((yield* Effect.flip(recovering.panes())).reason.cause)).toContain("aborted");
      expect(yield* recovering.start()).toEqual({ pane: "notes/1" });
    }).pipe(Effect.scoped),
  );

  it.effect("answers after an eviction with the one client it made", () =>
    Effect.gen(function* () {
      const host = yield* plugins;

      yield* host(() => plugin("client-evicted")).install({
        code: { plugin: "notes", pane: true },
      });
      yield* Effect.promise(() => evictDurableObject(plugin("client-evicted")));

      expect(yield* host(() => plugin("client-evicted")).start()).toEqual({ pane: "notes/1" });
    }).pipe(Effect.scoped),
  );

  it.effect("fails a call with the stub's failure, holding the runtime's error", () =>
    Effect.gen(function* () {
      const host = yield* plugins;

      const failure = yield* Effect.flip(
        host(() => ({
          effectActionsRpc: () => Promise.reject(new Error("The object is gone")),
        })).panes(),
      );

      expect(failure).toBeInstanceOf(RpcClientError.RpcClientError);
      expect(String(failure.reason.cause)).toContain("The object is gone");
    }).pipe(Effect.scoped),
  );

  it.effect("calls a group's unary rpcs, an rpc that streams having no method", () =>
    Effect.gen(function* () {
      const streams = (yield* ActionDurableObject.client(StreamRpcs))(() =>
        env.STREAMED.getByName("client-streams"),
      );

      expect(Object.keys(streams)).toEqual(["head"]);
      expect(yield* streams.head()).toBe("head");
    }).pipe(Effect.scoped),
  );

  it.effect("reaches one object from another's service", () =>
    Effect.gen(function* () {
      const host = yield* plugins;

      const pane = yield* RpcClient.make(PaneRpcs).pipe(
        Effect.provide(ActionDurableObject.layerStubClient(env.PANE_HOST.getByName("pane"))),
      );

      expect(yield* Effect.flip(pane.open({ plugin: "from-pane" }))).toEqual(
        new PluginNotFound({ plugin: "unknown" }),
      );
      yield* host(() => plugin("from-pane")).install({ code: { plugin: "notes", pane: true } });
      expect(yield* pane.open({ plugin: "from-pane" })).toEqual({ pane: "notes/1" });
      expect(yield* host(() => plugin("from-pane")).panes()).toEqual(["notes/1"]);
    }).pipe(Effect.scoped),
  );
});
