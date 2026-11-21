import type * as Worker from "./worker.ts";

declare global {
  namespace Cloudflare {
    interface Env {
      readonly CLUSTER_ENTITY: DurableObjectNamespace;
      readonly CLUSTER_WORKFLOW: DurableObjectNamespace;
      readonly CLUSTER_QUEUE: DurableObjectNamespace;
      readonly CLUSTER_SINGLETON: DurableObjectNamespace;
      readonly MCP_ENDPOINT: DurableObjectNamespace;
    }

    interface GlobalProps {
      mainModule: typeof Worker;
    }
  }
}
