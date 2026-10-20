import { env, evictDurableObject } from "cloudflare:test";
import { Cause, Effect, Exit, Stream } from "effect";
import { RpcClient, RpcClientError } from "effect/rpc";
import { describe, expect, it } from "@effect/vitest";
import * as Action from "@gjermundgaraba/effect-actions/Action";
import * as ActionRpc from "@gjermundgaraba/effect-actions/ActionRpc";
import * as ActionDurableObject from "../../src/durable/ActionDurableObject.js";
import { noteHeader, Overdrawn, Rpc } from "../support/app.js";
import {
  PaneRpcs,
  PluginHasNoPane,
  PluginNotFound,
  PluginRpcs,
  StreamRpcs,
} from "../support/hosts.js";

const plugin = (id: string) => env.PLUGIN_HOST.getByName(id);

const plugins = ActionDurableObject.client(PluginRpcs, plugin);

const rawOver = (stub: ActionDurableObject.Stub) =>
  RpcClient.make(PluginRpcs).pipe(Effect.provide(ActionDurableObject.layerStubClient(stub)));

const defectOf = <A, E>(exit: Exit.Exit<A, E>) =>
  Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined;

const asAda = RpcClient.withHeaders({ authorization: "Bearer ada" });

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
      const client = yield* rawOver({ effectActionsRpc: () => Promise.resolve("[]") });

      const error = yield* Effect.flip(client.panes());

      expect(error.reason.message).toBe("The object's answer ended before the call completed");
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
          "No rpc server runs on this object's ActionDurableObject.layerStub",
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

  it.effect("serves through Calls in a class composing the primitives itself", () =>
    Effect.gen(function* () {
      const client = yield* rawOver(env.MANUAL.getByName("calls"));

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

  it.effect("refuses a second stub protocol in one object as its calls build", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        Effect.flatMap(rawOver(env.TWO_PROTOCOLS.getByName("two")), (client) => client.panes()),
      );

      expect(String(error.reason.cause)).toContain("Two ActionDurableObject.layerStub protocols");
    }).pipe(Effect.scoped),
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
  it.effect("calls an object by its key, failing with the declared errors alone", () =>
    Effect.gen(function* () {
      const host = yield* plugins;

      expect(yield* Effect.flip(host("by-key").start())).toEqual(
        new PluginNotFound({ plugin: "unknown" }),
      );
      yield* host("by-key").install({ code: { plugin: "notes", pane: true } });
      expect(yield* host("by-key").start()).toEqual({ pane: "notes/1" });
      expect(yield* host("another").panes()).toEqual([]);
    }).pipe(Effect.scoped),
  );

  it.effect("answers several calls in flight to several objects with their own responses", () =>
    Effect.gen(function* () {
      const host = yield* plugins;

      const calls = ["a", "b", "c", "a", "b"].map((id, index) => ({
        id,
        text: `${id}${index}`,
        millis: 10 * (5 - index),
      }));

      expect(
        yield* Effect.forEach(calls, ({ id, ...call }) => host(id).echo(call), {
          concurrency: "unbounded",
        }),
      ).toEqual(calls.map(({ text }) => text));
    }).pipe(Effect.scoped),
  );

  it.effect("answers after an eviction with the one client it made", () =>
    Effect.gen(function* () {
      const host = yield* plugins;

      yield* host("client-evicted").install({ code: { plugin: "notes", pane: true } });
      yield* Effect.promise(() => evictDurableObject(plugin("client-evicted")));

      expect(yield* host("client-evicted").start()).toEqual({ pane: "notes/1" });
    }).pipe(Effect.scoped),
  );

  it.effect("makes a transport failure a defect", () =>
    Effect.gen(function* () {
      const host = yield* ActionDurableObject.client(PluginRpcs, (id: string) => ({
        effectActionsRpc: () => Promise.reject(new Error(`The object ${id} is gone`)),
      }));

      const exit = yield* Effect.exit(host("gone").panes());

      expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true);
      expect(defectOf(exit)).toBeInstanceOf(RpcClientError.RpcClientError);
    }).pipe(Effect.scoped),
  );

  it.effect("refuses a group with an rpc that streams as it is made", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        ActionDurableObject.client(StreamRpcs, (id: string) => env.STREAMED.getByName(id)),
      );

      expect(String(defectOf(exit))).toContain("The rpc tail streams");
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
      yield* host("from-pane").install({ code: { plugin: "notes", pane: true } });
      expect(yield* pane.open({ plugin: "from-pane" })).toEqual({ pane: "notes/1" });
      expect(yield* host("from-pane").panes()).toEqual(["notes/1"]);
    }).pipe(Effect.scoped),
  );
});
