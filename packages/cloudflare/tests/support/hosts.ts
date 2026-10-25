import { env } from "cloudflare:workers";
import { Context, Effect, Layer, Schema, Stream } from "effect";
import { Rpc, RpcGroup, RpcServer } from "effect/rpc";
import * as ActionDurableObject from "../../src/durable/ActionDurableObject.js";
import { layerStub } from "../../src/durable/calls.js";

export class PluginNotFound extends Schema.TaggedError<PluginNotFound>()("PluginNotFound", {
  plugin: Schema.String,
}) {}

export class PluginHasNoPane extends Schema.TaggedError<PluginHasNoPane>()("PluginHasNoPane", {
  plugin: Schema.String,
}) {}

export const Code = Schema.Struct({ plugin: Schema.String, pane: Schema.Boolean });

export const PluginRpcs = RpcGroup.make(
  Rpc.make("install", { payload: { code: Code }, success: Schema.Struct({ version: Schema.Int }) }),
  Rpc.make("start", {
    success: Schema.Struct({ pane: Schema.String }),
    error: Schema.Union([PluginNotFound, PluginHasNoPane]),
  }),
  Rpc.make("panes", { success: Schema.Array(Schema.String) }),
  Rpc.make("echo", {
    payload: { text: Schema.String, millis: Schema.Int },
    success: Schema.String,
  }),
);

export class PluginStore extends Context.Service<
  PluginStore,
  {
    readonly installed: () => typeof Code.Type | undefined;
    readonly install: (code: typeof Code.Type) => number;
    readonly started: () => ReadonlyArray<string>;
    readonly start: (pane: string) => void;
  }
>()("test/PluginStore") {
  static readonly layer = Layer.effect(PluginStore)(
    Effect.map(Effect.service(ActionDurableObject.State), ({ storage: { kv } }) =>
      PluginStore.of({
        installed: () => kv.get<typeof Code.Type>("installed"),
        install: (code) => {
          const version = (kv.get<number>("version") ?? 0) + 1;

          kv.put("installed", code);
          kv.put("version", version);

          return version;
        },
        started: () => kv.get<ReadonlyArray<string>>("panes") ?? [],
        start: (pane) => kv.put("panes", [...(kv.get<ReadonlyArray<string>>("panes") ?? []), pane]),
      }),
    ),
  );
}

const pluginHandlers = PluginRpcs.toLayer(
  Effect.map(Effect.service(PluginStore), (store) =>
    PluginRpcs.of({
      install: ({ code }) => Effect.sync(() => ({ version: store.install(code) })),
      start: () =>
        Effect.gen(function* () {
          const installed = store.installed();

          if (installed === undefined) return yield* new PluginNotFound({ plugin: "unknown" });

          if (!installed.pane) return yield* new PluginHasNoPane({ plugin: installed.plugin });

          const pane = `${installed.plugin}/${store.started().length + 1}`;

          store.start(pane);

          return { pane };
        }),
      panes: () => Effect.sync(() => store.started()),
      echo: ({ text, millis }) => Effect.as(Effect.sleep(millis), text),
    }),
  ),
);

export const pluginCalls = RpcServer.layer(PluginRpcs).pipe(Layer.provide(pluginHandlers));

export class Hosts extends Context.Service<
  Hosts,
  { readonly plugin: (id: string) => ActionDurableObject.Client<typeof PluginRpcs> }
>()("test/Hosts") {
  static readonly layer = Layer.effect(Hosts)(
    Effect.map(ActionDurableObject.client(PluginRpcs), (plugin) =>
      Hosts.of({ plugin: (id) => plugin(() => env.PLUGIN_HOST.getByName(id)) }),
    ),
  );
}

export const PaneRpcs = RpcGroup.make(
  Rpc.make("open", {
    payload: { plugin: Schema.String },
    success: Schema.Struct({ pane: Schema.String }),
    error: Schema.Union([PluginNotFound, PluginHasNoPane]),
  }),
);

export const paneCalls = RpcServer.layer(PaneRpcs).pipe(
  Layer.provide(
    PaneRpcs.toLayer(
      Effect.map(Effect.service(Hosts), (hosts) =>
        PaneRpcs.of({
          open: ({ plugin }) =>
            Effect.catchTag(hosts.plugin(plugin).start(), "RpcClientError", Effect.die),
        }),
      ),
    ),
  ),
);

export const StreamRpcs = RpcGroup.make(
  Rpc.make("tail", { success: Schema.String, stream: true }),
  Rpc.make("head", { success: Schema.String }),
);

export const streamCalls = RpcServer.layer(StreamRpcs).pipe(
  Layer.provide(
    StreamRpcs.toLayer({
      tail: () => Stream.make("a", "b"),
      head: () => Effect.succeed("head"),
    }),
  ),
);

export const twoProtocolCalls = Layer.mergeAll(
  pluginCalls.pipe(Layer.provide(layerStub())),
  streamCalls.pipe(Layer.provide(layerStub())),
).pipe(Layer.provide(PluginStore.layer));
