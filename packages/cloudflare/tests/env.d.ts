declare namespace Cloudflare {
  interface Env {
    readonly PLAIN: DurableObjectNamespace<import("./worker.ts").Plain>;
    readonly ROOM: DurableObjectNamespace<import("./worker.ts").Room>;
    readonly EXTENDED: DurableObjectNamespace<import("./worker.ts").Extended>;
    readonly ROUTER_PROVIDED: DurableObjectNamespace<import("./worker.ts").RouterProvided>;
    readonly PREFIXED: DurableObjectNamespace<import("./worker.ts").Prefixed>;
    readonly BROKEN: DurableObjectNamespace<import("./worker.ts").Broken>;
    readonly BROKEN_SERVICES: DurableObjectNamespace<import("./worker.ts").BrokenServices>;
    readonly COUNTED: DurableObjectNamespace<import("./worker.ts").Counted>;
    readonly OWN_SOCKETS: DurableObjectNamespace<import("./worker.ts").OwnSockets>;
    readonly RETRIED: DurableObjectNamespace<import("./worker.ts").Retried>;
    readonly RETRIED_AT_ONCE: DurableObjectNamespace<import("./worker.ts").RetriedAtOnce>;
    readonly HOSTED: DurableObjectNamespace<import("./worker.ts").Hosted>;
    readonly MANUAL: DurableObjectNamespace<import("./worker.ts").Manual>;
    readonly PLUGIN_HOST: DurableObjectNamespace<import("./worker.ts").PluginHost>;
    readonly PANE_HOST: DurableObjectNamespace<import("./worker.ts").PaneHost>;
    readonly STUBBED: DurableObjectNamespace<import("./worker.ts").Stubbed>;
    readonly STREAMED: DurableObjectNamespace<import("./worker.ts").Streamed>;
    readonly NATIVE: DurableObjectNamespace<import("./worker.ts").Native>;
    readonly UNSERVED: DurableObjectNamespace<import("./worker.ts").Unserved>;
    readonly FROM_ENV: DurableObjectNamespace<import("./worker.ts").FromEnv>;
    readonly DELEGATING: DurableObjectNamespace<import("./worker.ts").Delegating>;
    readonly FED: DurableObjectNamespace<import("./worker.ts").Fed>;
    readonly TWO_PATHS: DurableObjectNamespace<import("./worker.ts").TwoPaths>;
    readonly GREETING: string;
  }
}
