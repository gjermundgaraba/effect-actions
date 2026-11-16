import type { Shopper } from "./Identity.js";

export const demoShoppers = {
  ada: { id: "ada" },
  grace: { id: "grace" },
} satisfies Record<string, Shopper>;
