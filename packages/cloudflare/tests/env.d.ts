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
    readonly HOSTED: DurableObjectNamespace<import("./worker.ts").Hosted>;
    readonly MANUAL: DurableObjectNamespace<import("./worker.ts").Manual>;
  }
}
