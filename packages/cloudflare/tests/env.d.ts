declare namespace Cloudflare {
  interface Env {
    readonly PLAIN: DurableObjectNamespace<import("./worker.ts").Plain>;
    readonly ROOM: DurableObjectNamespace<import("./worker.ts").Room>;
    readonly EXTENDED: DurableObjectNamespace<import("./worker.ts").Extended>;
    readonly ROUTER_PROVIDED: DurableObjectNamespace<import("./worker.ts").RouterProvided>;
    readonly PREFIXED: DurableObjectNamespace<import("./worker.ts").Prefixed>;
    readonly BROKEN: DurableObjectNamespace<import("./worker.ts").Broken>;
  }
}
