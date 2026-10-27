import type {
  Broken,
  BrokenServices,
  BuiltAgainRaced,
  Counted,
  Delegating,
  Extended,
  Failing,
  FromEnv,
  Hooking,
  Hosted,
  LatchedRaced,
  Native,
  OwnSockets,
  PaneHost,
  Plain,
  PluginHost,
  Prefixed,
  Raced,
  Retried,
  RetriedAtOnce,
  Room,
  RouterProvided,
  Shelf,
  Streamed,
  Stubbed,
  Tasked,
  Unserved,
  Versioned,
  Watching,
} from "./worker.ts";

declare global {
  namespace Cloudflare {
    interface Env {
      readonly PLAIN: DurableObjectNamespace<Plain>;
      readonly ROOM: DurableObjectNamespace<Room>;
      readonly EXTENDED: DurableObjectNamespace<Extended>;
      readonly ROUTER_PROVIDED: DurableObjectNamespace<RouterProvided>;
      readonly PREFIXED: DurableObjectNamespace<Prefixed>;
      readonly BROKEN: DurableObjectNamespace<Broken>;
      readonly BROKEN_SERVICES: DurableObjectNamespace<BrokenServices>;
      readonly COUNTED: DurableObjectNamespace<Counted>;
      readonly OWN_SOCKETS: DurableObjectNamespace<OwnSockets>;
      readonly RETRIED: DurableObjectNamespace<Retried>;
      readonly RETRIED_AT_ONCE: DurableObjectNamespace<RetriedAtOnce>;
      readonly HOSTED: DurableObjectNamespace<Hosted>;
      readonly PLUGIN_HOST: DurableObjectNamespace<PluginHost>;
      readonly PANE_HOST: DurableObjectNamespace<PaneHost>;
      readonly STUBBED: DurableObjectNamespace<Stubbed>;
      readonly STREAMED: DurableObjectNamespace<Streamed>;
      readonly NATIVE: DurableObjectNamespace<Native>;
      readonly RACED: DurableObjectNamespace<Raced>;
      readonly BUILT_AGAIN_RACED: DurableObjectNamespace<BuiltAgainRaced>;
      readonly LATCHED_RACED: DurableObjectNamespace<LatchedRaced>;
      readonly UNSERVED: DurableObjectNamespace<Unserved>;
      readonly FROM_ENV: DurableObjectNamespace<FromEnv>;
      readonly DELEGATING: DurableObjectNamespace<Delegating>;
      readonly FAILING: DurableObjectNamespace<Failing>;
      readonly VERSIONED: DurableObjectNamespace<Versioned>;
      readonly WATCHING: DurableObjectNamespace<Watching>;
      readonly HOOKING: DurableObjectNamespace<Hooking>;
      readonly SHELF: DurableObjectNamespace<Shelf>;
      readonly TASKED: DurableObjectNamespace<Tasked>;
      readonly GREETING: string;
    }
  }
}
