declare namespace Cloudflare {
  interface Env {
    readonly PLAIN: DurableObjectNamespace<import("./worker.ts").Plain>;
    readonly ROOM: DurableObjectNamespace<import("./worker.ts").Room>;
    readonly BROKEN: DurableObjectNamespace<import("./worker.ts").Broken>;
  }
}
