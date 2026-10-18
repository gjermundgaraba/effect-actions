declare namespace Cloudflare {
  interface Env {
    readonly PLAIN: DurableObjectNamespace<import("./worker.ts").Plain>;
  }
}
