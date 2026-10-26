// The Worker's bindings and its main module, as `wrangler types` writes them from
// wrangler.jsonc: regenerate them with it when the configuration changes.
declare namespace Cloudflare {
  interface Env {
    readonly CHAT_ROOM: DurableObjectNamespace<import("./worker.js").ChatRoom>;
    readonly CHAT_LOBBY: DurableObjectNamespace<import("./worker.js").ChatLobby>;
  }

  interface GlobalProps {
    mainModule: typeof import("./worker.js");
  }
}
